import type { Page } from 'playwright'
import { Result } from '@praha/byethrow'
import { createLogger } from '#/logger'
import { accountManager } from '#/managers/AccountManager'
import { type IPlatform, isCommentListener, isPerformComment, isPerformPopup } from '#/platforms/IPlatform'
import type {
  HostAction,
  HostIdentityContext,
  HostIdentitySource,
} from './vendor/hostIdentity'
import type { AccountSurface } from './vendor/accountGovernance'

const logger = createLogger('准入桥接/身份源')

/**
 * 真实宿主侧的身份数据源。
 *
 * 这份文件要解决的是交接文档点名的核心问题：**"读到的身份"必须是页面上真实发生的事实，
 * 不能回显请求参数、不能从宿主自己的账号配置反推、不能从昵称猜角色**。
 *
 * 目前实现了三件可证明的事（都在钉住的 Page 上读，且整段 read→execute 期间页面不能被换掉）：
 *   1. 这个 surface 现在钉在哪张页面上（URL 与页面对象）；
 *   2. 登录态：页面是否仍停在登录页 / 是否出现"已登录"标记；
 *   3. 页面上的账号显示名（**弱身份**，按约定只能做弱关联，不当稳定 ID）。
 *
 * 明确**还没有**实现、因此一律拒绝放行的四项：稳定达人 ID、稳定房间 ID、实际执行者 ID、
 * 角色与权限（room_admin / buyin_subaccount / reply / popup / block ...）。
 * 这四项需要先在已登录的真实页面上确认数据来源（DOM 里的可信字段，或页面自己发起的、带签名的
 * 接口响应）。在拿到证据之前，`read()` 直接抛 `host_identity_unprovable`，
 * 于是鉴权边界会拒绝所有观察与执行——这是刻意的失败方向，不是"还没测"。
 */

export interface IdentityEvidenceOptions {
  /** 抖音助理（中控台）对应宿主里的哪个账号；对应 AccountManager 的 accountId。 */
  douyinAccountId: string | null
  /** 百应子账号对应宿主里的哪个账号。 */
  buyinAccountId: string | null
  /**
   * 稳定身份证据的来源。默认 null = 没有实现，全部拒绝。
   * 之后在真实登录页面上确认了来源，再在这里提供实现，而不是在 read() 里猜。
   */
  stableIdentity?: (input: {
    surface: AccountSurface
    page: Page
    displayName: string | null
    href: string
  }) => Promise<StableIdentityEvidence | null>
}

export interface StableIdentityEvidence {
  /** 被管理达人的稳定 ID（平台稳定标识，不是昵称、不是展示抖音号）。 */
  accountId: string
  /** 直播间稳定 ID。 */
  roomId: string
  /** 当前页面的实际执行者稳定 ID（抖音助理 / 百应子账号）。 */
  executorId: string
  role: 'room_admin' | 'buyin_subaccount'
  /** 从页面/平台证据证明到的权限，必须来自证据而不是配置。 */
  permissions: string[]
  /** 证据引用：截图路径、接口响应哈希等可追溯的线索。 */
  evidenceRef: string
}

/** 一次上下文里的页面钉子：页面被关掉、被导航走、被换号，都算失效。 */
interface PinnedPage {
  page: Page
  surface: AccountSurface
  /** 钉住时的 URL；用于发现"人工点了别的页面"。 */
  startedHref: string | null
  invalidReason: string | null
}

const SURFACE_PLATFORM_EXPECTATION: Record<AccountSurface, string> = {
  douyin_room: '抖音小店',
  buyin: '巨量百应',
}

export class PlaywrightIdentitySource implements HostIdentitySource {
  /** 每张 surface 一条串行队列：同一页面上的读与执行不并发，避免互相看到对方的中间态。 */
  private readonly lanes = new Map<AccountSurface, Promise<unknown>>()
  private readonly options: IdentityEvidenceOptions

  constructor(options: IdentityEvidenceOptions) {
    this.options = options
  }

  async withContext<T>(
    surface: AccountSurface,
    run: (context: HostIdentityContext) => Promise<T>,
  ): Promise<T> {
    return this.serial(surface, async () => {
      const pinned = await this.pin(surface)
      const onNavigated = () => {
        pinned.invalidReason = 'host_context_navigated'
      }
      const onClosed = () => {
        pinned.invalidReason = 'host_context_closed'
      }
      pinned.page.on('framenavigated', onNavigated)
      pinned.page.on('close', onClosed)
      try {
        return await run(this.buildContext(pinned))
      } finally {
        pinned.page.off('framenavigated', onNavigated)
        pinned.page.off('close', onClosed)
      }
    })
  }

  private serial<T>(surface: AccountSurface, run: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(surface) ?? Promise.resolve()
    const result = previous.then(run, run)
    this.lanes.set(
      surface,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }

  /** 把这张 surface 绑到具体账号的**具体那张页面**，并记录起始 URL。 */
  private async pin(surface: AccountSurface): Promise<PinnedPage> {
    const accountId =
      surface === 'douyin_room' ? this.options.douyinAccountId : this.options.buyinAccountId
    if (!accountId) throw new Error('host_account_not_configured')
    const session = accountManager.getSession(accountId)
    if (Result.isFailure(session)) throw new Error('host_account_not_connected')
    const platform: IPlatform = session.value.getPlatform()
    if (platform.platformName !== SURFACE_PLATFORM_EXPECTATION[surface]) {
      // 平台对不上就直接拒绝：这比"用错页面读身份"要安全得多。
      throw new Error('host_surface_platform_mismatch')
    }
    const page = pageForSurface(surface, platform)
    if (!page || page.isClosed()) throw new Error('host_page_unavailable')
    let startedHref: string | null = null
    try {
      startedHref = page.url()
    } catch {
      startedHref = null
    }
    return { page, surface, startedHref, invalidReason: null }
  }

  private buildContext(pinned: PinnedPage): HostIdentityContext {
    const assertLive = () => {
      if (pinned.invalidReason) throw new Error(pinned.invalidReason)
      if (pinned.page.isClosed()) throw new Error('host_context_closed')
    }

    return {
      read: async (signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error('host_request_cancelled')
        assertLive()
        const snapshot = await this.snapshot(pinned)
        if (signal?.aborted) throw new Error('host_request_cancelled')

        if (!snapshot.stable) {
          // 关键决定：宁可整条拒绝，也不拿"显示名 + 配置里的 ID"拼一个看起来合法的身份。
          logger.warn('身份证据不足，拒绝放行', {
            surface: pinned.surface,
            reason: snapshot.stableReason,
            hrefOrigin: safeOrigin(snapshot.href),
          })
          throw new Error('host_identity_unprovable')
        }

        return {
          platform: pinned.surface === 'buyin' ? 'buyin' : 'douyin',
          accountId: snapshot.stable.accountId,
          roomId: snapshot.stable.roomId,
          // sessionId 由业务侧请求里的作用域决定，这里只回显观察到的稳定作用域；
          // 边界会做 hash 比对，对不上就拒绝，所以这里必须填真实观察到的那一份。
          sessionId: snapshot.sessionIdFromPage ?? '',
          surface: pinned.surface,
          executorId: snapshot.stable.executorId,
          loginState: snapshot.loginState,
          role: snapshot.stable.role,
          roleVerified: true,
          permissions: snapshot.stable.permissions,
          observedAt: new Date().toISOString(),
          // 非秘密的登录代号：页面 + 账号 + 执行者 + 角色 + 权限的稳定组合。
          // 换号/换达人/撤权/页面重建都会改变它；正常刷新不应改变（时间戳不参与）。
          identityRevision: identityRevisionOf(pinned.surface, snapshot),
          executionGuard: 'identity_revision_v2',
          evidenceMode: 'platform',
        }
      },
      execute: async (_action: HostAction, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error('host_request_cancelled')
        assertLive()
        // 真实执行开关默认关闭，而且即使打开也必须先有可证明的身份（上面 read 的路径）。
        throw new Error('host_execution_disabled')
      },
      // 故意不实现 reconcile：没有可信的对账来源时，业务侧应保持 uncertain，而不是被"猜"成确认。
    }
  }

  private async snapshot(pinned: PinnedPage): Promise<PageSnapshot> {
    const page = pinned.page
    const href = page.url()
    if (pinned.startedHref !== null && href !== pinned.startedHref && !isSameAppHref(pinned.startedHref, href)) {
      // 人工点了别的页面/换了账号：这一段上下文立刻作废。
      pinned.invalidReason = 'host_context_navigated'
      throw new Error('host_context_navigated')
    }
    const displayName = await readDisplayName(page)
    const loginState = await readLoginState(page)
    const stable = this.options.stableIdentity
      ? await this.options.stableIdentity({ surface: pinned.surface, page, displayName, href })
      : null
    return {
      href,
      displayName,
      loginState,
      stable,
      stableReason: stable ? null : 'stable_identity_source_not_implemented',
      sessionIdFromPage: null,
    }
  }
}

interface PageSnapshot {
  href: string
  displayName: string | null
  loginState: 'authenticated' | 'logged_out' | 'unknown'
  stable: StableIdentityEvidence | null
  stableReason: string | null
  sessionIdFromPage: string | null
}

function pageForSurface(surface: AccountSurface, platform: IPlatform): Page | null {
  if (surface === 'douyin_room') {
    // 优先用评论监听页（真正在中控台直播间里的那张），没有就用主页面。
    if (isCommentListener(platform)) {
      try {
        return platform.getCommentListenerPage()
      } catch {
        // 监听还没启动：回落到评论页/主页面。
      }
    }
    if (isPerformComment(platform)) return platform.getCommentPage()
    return null
  }
  if (isPerformPopup(platform)) return platform.getPopupPage()
  return null
}

/** 首页 vs 中控台之间的跳转不算"换上下文"；跨域或换账号才算。 */
function isSameAppHref(from: string, to: string): boolean {
  try {
    return new URL(from).origin === new URL(to).origin
  } catch {
    return false
  }
}

function safeOrigin(href: string): string | null {
  try {
    return new URL(href).origin
  } catch {
    return null
  }
}

/**
 * 登录态：只认页面自身的事实。
 * 页面 URL 命中登录地址 → logged_out；页面上有"已登录"标记 → authenticated；其余 unknown。
 */
async function readLoginState(page: Page): Promise<'authenticated' | 'logged_out' | 'unknown'> {
  const href = page.url()
  if (/\/(login|passport)\b/i.test(href)) return 'logged_out'
  try {
    const marker = await page
      .evaluate(
        () =>
          Boolean(
            document.querySelector(
              '[class*="userInfo"], [class*="user-info"], [class*="accountInfo"], [class*="avatar"]',
            ),
          ),
      )
      .catch(() => false)
    return marker ? 'authenticated' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 显示名只作弱身份；拿不到就是 null，不猜。 */
async function readDisplayName(page: Page): Promise<string | null> {
  try {
    const text = await page.evaluate(() => {
      const node = document.querySelector(
        '[class*="userName"], [class*="user-name"], [class*="accountName"]',
      )
      const value = node?.textContent?.trim() ?? ''
      return value.length > 0 && value.length <= 60 ? value : ''
    })
    return text || null
  } catch {
    return null
  }
}

function identityRevisionOf(surface: AccountSurface, snapshot: PageSnapshot): string {
  const stable = snapshot.stable
  if (!stable) return `unprovable-${surface}`
  return [
    'v2',
    surface,
    stable.accountId,
    stable.roomId,
    stable.executorId,
    stable.role,
    [...stable.permissions].sort().join('+'),
  ].join('|')
}
