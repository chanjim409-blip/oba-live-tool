/**
 * 真实直播数据采集（只读）。
 *
 * 数据来源**只有页面自身发出的请求的响应**，我们不发任何额外请求、不点赞、不进场、不发言：
 *   · 中控台 `promotions_v2`        → 本场挂车货盘（product_id / promotion_id / stock_num / status）与 room_id
 *   · 中控台 `livepc/playinfo`      → 当前直播间号（开播态的唯一可靠判据）
 *   · 罗盘大屏 `message?`           → 弹幕 / 进场 / 点赞 / 分享（`data.messages.{comment,room_enter,…}`）
 *   · 罗盘大屏 `live_order_stream?` → 订单事件（本轮只统计，不进业务事件流）
 *
 * 关于身份：罗盘的弹幕消息**不含稳定观众 ID**，只有 `nick_name`。所以：
 *   viewerId 用 `weak:<nick 的 sha1 前缀>`，并标 `identityQuality: "weak"`。
 *   这意味着跨观众合并/同人判定只能按昵称弱关联，原生@这类"必须稳定身份"的动作会被业务侧拒绝——
 *   这是正确方向，不许在这里把昵称冒充成稳定 ID。
 * occurredAt 用**我们观察到该响应的时刻**，不是平台时间戳（平台没给，别编）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright'

export interface TapCommentEvent {
  roomId: string
  /** 平台消息 ID（19 位），用作 SSE 的 id 与去重键 */
  id: string
  nickname: string
  text: string
  /** 观察到该消息的时刻（ISO），不是平台时间戳 */
  occurredAt: string
  kind: 'comment'
}

export interface CatalogSnapshot {
  version: number
  observedAt: string
  roomId: string | null
  items: Array<{ productId: string; promotionId: string | null; ordinal: number; available: boolean; title: string | null; stock: number | null }>
}

export interface TapOptions {
  /** 登录态文件（Playwright storageState JSON）。本机私有目录，不进仓库。 */
  storageStatePath: string
  /** 本机 Chrome/Edge 可执行文件；不指定则用 Playwright 自带浏览器（可能没装）。 */
  executablePath?: string | null
  headless?: boolean
  consoleUrl?: string
  compassIndex?: string
  compassScreen?: string
  /** 事件环形缓冲大小，用于 SSE 断线续传 */
  bufferSize?: number
  log?: (message: string) => void
}

const DEFAULTS = {
  consoleUrl: 'https://buyin.jinritemai.com/dashboard/live/control',
  compassIndex: 'https://compass.jinritemai.com/talent',
  compassScreen: 'https://compass.jinritemai.com/screen/anchor/talent?live_room_id=',
}

const isValidRoomId = (value: unknown) => typeof value === 'string' && /^[0-9]{10,}$/.test(value)
const weakId = (nickname: string) => `weak:${createHash('sha1').update(nickname).digest('hex').slice(0, 16)}`

export class LiveTap {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private consolePage: Page | null = null
  private compassPage: Page | null = null
  private readonly listeners = new Set<(event: TapCommentEvent) => void>()
  private readonly buffer: TapCommentEvent[] = []
  private readonly seen = new Set<string>()
  private readonly options: Required<Pick<TapOptions, 'storageStatePath' | 'consoleUrl' | 'compassIndex' | 'compassScreen' | 'bufferSize'>> & TapOptions

  roomId: string | null = null
  playinfoRoomId: string | null = null
  loggedIn = false
  compassAttached = false
  compassBlockedReason: string | null = null
  lastEventAt: string | null = null
  lastCommentPollAt: number | null = null
  commentCount = 0
  enterCount = 0
  likeCount = 0
  shareCount = 0
  orderCount = 0
  catalog: CatalogSnapshot | null = null
  /**
   * 从 `/index/getUser` 读到的真实身份事实。业务侧绑账号要用稳定 ID，
   * 所以必须给出真实值（仅回环 + Bearer token 可读），不能只给掩码。
   */
  facts: { userId: string | null; originUid: string | null; buyinAccountId: string | null; drAuth: unknown; observedAt: string } | null = null
  private catalogSignature = ''
  private pageGeneration = 0
  private identityUrl: string | null = null
  private identityRefresh: Promise<void> | null = null
  errors: string[] = []
  startedAt: string | null = null

  constructor(options: TapOptions) {
    this.options = { ...DEFAULTS, bufferSize: 300, ...options } as never
  }

  private log(message: string) {
    this.options.log?.(message)
  }

  /** 当前是否"开播中"：唯一判据是拿到本场 room_id（文本匹配和历史 last_room_id 都不可靠）。 */
  get live(): boolean {
    return isValidRoomId(this.roomId) || isValidRoomId(this.playinfoRoomId)
  }

  get currentRoomId(): string | null {
    return this.roomId ?? this.playinfoRoomId
  }

  /** Empty successful polls count as health; silence in the room must not look like a broken collector. */
  get eventSourceHealthy(): boolean {
    const age = this.lastCommentPollAt === null ? Infinity : Date.now() - this.lastCommentPollAt
    return this.loggedIn && this.live && this.compassAttached && age >= 0 && age <= 60_000
  }

  recent(sinceId?: string | null): TapCommentEvent[] {
    if (!sinceId) return []
    const index = this.buffer.findIndex((event) => event.id === sinceId)
    return index >= 0 ? this.buffer.slice(index + 1) : []
  }

  subscribe(listener: (event: TapCommentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: TapCommentEvent) {
    if (event.roomId !== this.currentRoomId || /[\r\n\0]/.test(event.id)) return
    if (this.seen.has(event.id)) return
    this.seen.add(event.id)
    if (this.seen.size > 5000) this.seen.clear()
    this.commentCount += 1
    this.lastEventAt = event.occurredAt
    this.buffer.push(event)
    if (this.buffer.length > this.options.bufferSize) this.buffer.shift()
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* 单个订阅者异常不影响其它订阅者 */
      }
    }
  }

  /** Room changes discard the old room's cache and subscription before accepting new data. */
  private observeRoom(room: string | null): void {
    if (room === this.currentRoomId) return
    this.roomId = room
    this.playinfoRoomId = null
    this.catalog = null
    this.catalogSignature = ''
    this.buffer.length = 0
    this.seen.clear()
    this.commentCount = this.enterCount = this.likeCount = this.shareCount = this.orderCount = 0
    this.lastEventAt = null
    this.lastCommentPollAt = null
    const oldPage = this.compassPage
    this.compassPage = null
    this.compassAttached = false
    this.compassBlockedReason = null
    void oldPage?.close().catch(() => undefined)
  }

  private invalidatePage(): void {
    this.pageGeneration++
    this.loggedIn = false
    this.facts = null
    this.observeRoom(null)
  }

  async start(): Promise<void> {
    if (!existsSync(this.options.storageStatePath)) throw new Error('tap_storage_state_missing')
    const storageState = JSON.parse(readFileSync(this.options.storageStatePath, 'utf8'))
    this.browser = await chromium.launch({
      headless: this.options.headless ?? true,
      executablePath: this.options.executablePath ?? undefined,
    })
    this.context = await this.browser.newContext({ storageState, viewport: null })
    this.startedAt = new Date().toISOString()
    this.consolePage = await this.context.newPage()
    this.attachConsole(this.consolePage)
    await this.consolePage
      .goto(this.options.consoleUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch((error) => this.errors.push(`console_nav_failed:${error.message}`))
    this.loggedIn = await this.detectLogin()
    this.log(`中控台已打开，登录态=${this.loggedIn ? '已登录' : '未确认'}`)
  }

  /**
   * 登录态判定：等 SPA 渲染出账号节点（`domcontentloaded` 时页面还是空壳，上一版因此误报未登录）。
   * 20 秒内出现即视为已登录；期间一直有响应就说明登录态还在。
   */
  private async detectLogin(): Promise<boolean> {
    const page = this.consolePage
    if (!page || page.isClosed()) return false
    const selector = 'span.btn-item-role-exchange-name__title, [class^="userName"], [class*="role-exchange-name"]'
    const found = await page
      .waitForSelector(selector, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false)
    return found || (await page.evaluate((s) => Boolean(document.querySelector(s)), selector).catch(() => false))
  }

  private attachConsole(page: Page) {
    const requests = new WeakMap<Request, number>()
    page.on('request', request => requests.set(request, this.pageGeneration))
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        this.invalidatePage()
        if (this.identityUrl) void this.refreshIdentity()
      }
    })
    page.on('close', () => this.invalidatePage())
    page.on('response', async (response) => {
      const generation = requests.get(response.request())
      if (generation !== this.pageGeneration) return
      const url = response.url()
      const endpoint = new URL(url)
      if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'buyin.jinritemai.com') return
      if (!/json/i.test(response.headers()['content-type'] ?? '')) return
      try {
        if (/promotions_v2/.test(url)) {
          const body = await response.json()
          if (generation !== this.pageGeneration || page.isClosed()) return
          const data = body?.data ?? {}
          if (!isValidRoomId(String(data.room_id ?? '')) || !Array.isArray(data.promotions)) { this.observeRoom(null); return }
          this.observeRoom(String(data.room_id))
          const promotions = Array.isArray(data.promotions) ? data.promotions : []
          {
            const items = promotions.map((item: Record<string, unknown>, index: number) => ({
              productId: String(item.product_id ?? ''),
              promotionId: item.promotion_id === undefined || item.promotion_id === null ? null : String(item.promotion_id),
              ordinal: index + 1,
              // 可售判定用库存数：未知就按不可售处理，绝不猜"应该有货"
              available: Number(item.stock_num ?? 0) > 0,
              title: item.title === undefined || item.title === null ? null : String(item.title),
              stock: item.stock_num === undefined || item.stock_num === null ? null : Number(item.stock_num),
            }))
            const signature = JSON.stringify(items)
            if (signature !== this.catalogSignature) {
              const previous = this.catalog
              this.catalogSignature = signature
              this.catalog = {
                version: (previous?.version ?? 0) + 1,
                observedAt: new Date().toISOString(),
                roomId: this.currentRoomId,
                items,
              }
              this.log(`货盘变化：${items.length} 个商品（版本 ${this.catalog.version}）`)
            } else if (this.catalog) {
              this.catalog = { ...this.catalog, observedAt: new Date().toISOString(), items }
            }
          }
          void this.ensureCompass()
        } else if (endpoint.pathname.endsWith('/index/getUser')) {
          this.identityUrl = url
          const body = await response.json()
          if (generation !== this.pageGeneration || page.isClosed()) return
          const data = body?.data ?? {}
          const nextAccount = data.user_id ? String(data.user_id) : null
          if (this.facts && (this.facts.userId !== nextAccount || this.facts.buyinAccountId !== (data.buyin_account_id ? String(data.buyin_account_id) : null))) this.observeRoom(null)
          this.facts = {
            userId: data.user_id ? String(data.user_id) : null,
            originUid: data.origin_uid ? String(data.origin_uid) : null,
            buyinAccountId: data.buyin_account_id ? String(data.buyin_account_id) : null,
            drAuth: data.dr_auth ?? null,
            observedAt: new Date().toISOString(),
          }
          // SPA navigation invalidates login. Re-establish it from the current page, not the initial startup alone.
          const authenticatedPage = await this.detectLogin()
          if (generation === this.pageGeneration && !page.isClosed()) this.loggedIn = !!nextAccount && authenticatedPage
        } else if (/livepc\/playinfo/.test(url)) {
          const body = await response.json()
          if (generation !== this.pageGeneration || page.isClosed()) return
          const data = body?.data ?? {}
          this.observeRoom(isValidRoomId(String(data.room_id ?? '')) ? String(data.room_id) : null)
          void this.ensureCompass()
        }
      } catch {
        /* 非 JSON 或页面切换中 */
      }
    })
  }

  /** Re-read the already observed platform identity endpoint after SPA navigation; never reuse old facts. */
  async refreshIdentity(): Promise<void> {
    if (this.identityRefresh) return this.identityRefresh
    const page = this.consolePage
    const url = this.identityUrl
    if (!page || page.isClosed() || !url) return
    const generation = this.pageGeneration
    this.identityRefresh = (async () => {
      try {
        const response = await page.request.get(url, { timeout: 5000, maxRedirects: 0 })
        const body = await response.json()
        const data = body?.data
        if (!response.ok() || !data?.user_id || !data.buyin_account_id) throw new Error('identity_unavailable')
        const loggedIn = await this.detectLogin()
        if (generation !== this.pageGeneration || page.isClosed()) return
        if (this.facts && (this.facts.userId !== String(data.user_id)
          || this.facts.buyinAccountId !== String(data.buyin_account_id))) this.observeRoom(null)
        this.facts = { userId: String(data.user_id), originUid: data.origin_uid ? String(data.origin_uid) : null,
          buyinAccountId: String(data.buyin_account_id), drAuth: data.dr_auth ?? null, observedAt: new Date().toISOString() }
        this.loggedIn = loggedIn
      } catch {
        if (generation === this.pageGeneration) { this.loggedIn = false; this.facts = null }
      }
    })().finally(() => { this.identityRefresh = null })
    return this.identityRefresh
  }

  /** 拿到本场 room_id 后再挂罗盘大屏（它才是弹幕/互动的主通道）。 */
  private async ensureCompass(): Promise<void> {
    if (this.compassAttached || this.compassPage || !this.live || !this.context) return
    const roomId = this.currentRoomId
    if (!roomId) return
    this.compassAttached = true
    let ownedPage: Page | null = null
    try {
      const page = await this.context.newPage()
      if (roomId !== this.currentRoomId) { await page.close(); return }
      ownedPage = page
      this.compassPage = page
      page.on('response', async (response) => {
        if (page !== this.compassPage || roomId !== this.currentRoomId) return
        const url = response.url()
        if (!/json/i.test(response.headers()['content-type'] ?? '')) return
        try {
          if (url.includes('message?')) {
            const body = await response.json()
            if (page !== this.compassPage || roomId !== this.currentRoomId) return
            const messages = body?.data?.messages
            if (!messages || typeof messages !== 'object' || Array.isArray(messages)) return
            this.lastCommentPollAt = Date.now()
            const at = new Date().toISOString()
            for (const [type, list] of Object.entries(messages)) {
              if (!Array.isArray(list)) continue
              for (const raw of list) {
                const item = raw as Record<string, unknown>
                if (type === 'comment') {
                  const text = String(item.content ?? '').trim()
                  const nickname = String(item.nick_name ?? '').trim()
                  const id = String(item.msg_id ?? '')
                  if (!text || !id) continue
                  this.emit({ roomId, id, nickname, text, occurredAt: at, kind: 'comment' })
                } else if (type === 'room_enter') this.enterCount += 1
                else if (type === 'room_like') this.likeCount += 1
                else if (type === 'room_share') this.shareCount += 1
              }
            }
          } else if (url.includes('live_order_stream?')) {
            const body = await response.json()
            if (page !== this.compassPage || roomId !== this.currentRoomId) return
            if (Array.isArray(body?.data)) this.orderCount += body.data.length
          }
        } catch {
          /* 忽略单条解析失败 */
        }
      })
      await page.goto(this.options.compassIndex, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await page.waitForSelector('div[class^="userName"]', { timeout: 25_000 }).catch(() => {})
      if (page !== this.compassPage || roomId !== this.currentRoomId) return
      await page.goto(`${this.options.compassScreen}${roomId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      if (page !== this.compassPage || roomId !== this.currentRoomId) return
      const text = await page.evaluate(() => (document.body?.innerText ?? '').slice(0, 2000)).catch(() => '')
      if (/没有权限|不支持访问/.test(text)) {
        this.compassBlockedReason = 'compass_permission_missing'
        this.log('罗盘大屏提示无权限（需要主账号在【百应-子账号授权】里配置）')
      }
      this.log(`罗盘大屏已接入（room ${roomId.slice(0, 2)}…${roomId.slice(-2)}）`)
    } catch (error) {
      if (ownedPage !== this.compassPage || roomId !== this.currentRoomId) return
      this.compassAttached = false
      this.compassPage = null
      void ownedPage?.close().catch(() => undefined)
      this.errors.push(`compass_attach_failed:${error instanceof Error ? error.message : String(error)}`)
      this.log(`罗盘大屏接入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Explicit read-only recovery of this collector page; does not change account or permissions. */
  async refreshConsole(): Promise<void> {
    const page = this.consolePage
    if (!page || page.isClosed()) throw new Error('bridge_collector_unavailable')
    this.invalidatePage()
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 })
      await this.refreshIdentity()
      const generation = this.pageGeneration
      const authenticated = await this.detectLogin()
      if (generation === this.pageGeneration && !page.isClosed()) this.loggedIn = authenticated && !!this.facts?.userId
    } catch {
      this.invalidatePage()
      throw new Error('bridge_collector_refresh_failed')
    }
  }

  status() {
    return {
      logged_in: this.loggedIn,
      identity_endpoint_observed: !!this.identityUrl,
      identity_observed_at: this.facts?.observedAt ?? null,
      console_closed: !this.consolePage || this.consolePage.isClosed(),
      live: this.live,
      room_id: this.currentRoomId,
      compass_attached: this.compassAttached,
      compass_blocked: this.compassBlockedReason,
      started_at: this.startedAt,
      counts: { comment: this.commentCount, room_enter: this.enterCount, room_like: this.likeCount, room_share: this.shareCount, order: this.orderCount },
      last_event_at: this.lastEventAt,
      event_source_healthy: this.eventSourceHealthy,
      last_comment_poll_at: this.lastCommentPollAt === null ? null : new Date(this.lastCommentPollAt).toISOString(),
      catalog_version: this.catalog?.version ?? null,
      catalog_items: this.catalog?.items.length ?? 0,
      errors: this.errors.slice(-5),
    }
  }

  async stop(): Promise<void> {
    this.invalidatePage()
    this.listeners.clear()
    try {
      await this.context?.close()
    } catch {
      /* 关闭失败不影响退出 */
    }
    try {
      await this.browser?.close()
    } catch {
      /* 同上 */
    }
    this.context = null
    this.browser = null
    this.consolePage = null
    this.compassPage = null
    this.compassAttached = false
  }
}

export const weakViewerId = weakId
