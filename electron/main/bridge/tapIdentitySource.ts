/**
 * 真实身份源（百应面）：把 `LiveTap` 在页面上**实际观察到**的事实，按业务侧的
 * `IdentityObservation` 契约交出去。只读，不含任何动作执行。
 *
 * 能诚实地证明什么（每条都有证据来源）：
 *   · 登录态 = authenticated   ← 页面渲染出账号节点且未停在登录页
 *   · 执行者 executorId        ← `/index/getUser` 的 `buyin_account_id`（百应侧被授权的账号）
 *   · 角色/权限未验证：缓存 getUser 或曾经看到输入框不足以证明当前执行权限。
 *     roleVerified=false、permissions=[]，保留实际采样时间，不能续签旧证据。
 *   · 作用域交叉核对             ← 页面上的达人/房间必须与业务侧登记的场次作用域一致，否则拒绝
 *
 * 明确不做：`douyin_room` 面在本机没有页面（达人个人号在百应没有子账号体系，助理号只有无权限的
 * 作者后台），所以该面一律拒绝——宁可不提供，也不拿百应页面冒充"抖音直播间管理员"。
 * 也不回执执行：`execute()` 恒抛 `host_execution_disabled`。
 */
import type { AccountSurface } from './vendor/accountGovernance'
import type { HostAction, HostIdentityContext, HostIdentitySource } from './vendor/hostIdentity'
import type { LiveTap } from './liveTap'

export type { RegisteredScope } from './scopeGuard'
import { sameScope, type RegisteredScope } from './scopeGuard'

export class TapIdentitySource implements HostIdentitySource {
  constructor(
    private readonly tap: LiveTap,
    private readonly registered: () => RegisteredScope | null,
  ) {}

  async withContext<T>(surface: AccountSurface, run: (context: HostIdentityContext) => Promise<T>): Promise<T> {
    if (surface !== 'buyin') {
      // 本机没有 douyin_room 面的真实页面：明确拒绝，不伪造。
      throw new Error('host_surface_unprovisioned')
    }
    if (!this.tap.loggedIn) throw new Error('host_login_state_unknown')
    const scope = this.registered()
    if (!scope) throw new Error('host_session_not_registered')
    return run(this.context(surface, scope))
  }

  private context(surface: AccountSurface, scope: RegisteredScope): HostIdentityContext {
    return {
      read: async (signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error('host_request_cancelled')
        if (!sameScope(this.registered(), scope) || !this.tap.loggedIn) throw new Error('host_context_changed')
        const facts = this.tap.facts
        if (!facts?.buyinAccountId) throw new Error('host_executor_unknown')
        // 交叉核对：页面上的达人必须就是业务登记的达人；开播中房间号也必须一致。
        if (facts.userId !== scope.accountId) throw new Error('host_scope_mismatch')
        const room = this.tap.currentRoomId
        if (!room || room !== scope.roomId) throw new Error('host_scope_mismatch')
        const authority = readLiveAuthority(facts.drAuth)
        if (authority !== 1) throw new Error('host_permission_unproven')
        return {
          platform: scope.platform,
          accountId: scope.accountId,
          roomId: scope.roomId,
          sessionId: scope.sessionId,
          surface,
          executorId: facts.buyinAccountId,
          loginState: 'authenticated',
          role: 'buyin_subaccount',
          // Cached getUser does not establish the selected role or currently usable page controls.
          roleVerified: false,
          // A future real adapter must read the selected role/controls and pin their page context.
          permissions: [],
          observedAt: facts.observedAt,
          // 非秘密的登录代号：换号/换达人/换房间/权限变化都会改变它，正常刷新不变。
          identityRevision: `tap-v2|${facts.buyinAccountId}|${facts.userId}|${room ?? 'no-room'}|live=${authority}`,
          executionGuard: 'identity_revision_v2',
          evidenceMode: 'platform',
        }
      },
      execute: async (_action: HostAction, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error('host_request_cancelled')
        throw new Error('host_execution_disabled')
      },
    }
  }
}

/** `dr_auth` 里 authority_live 标志位；结构是 { [账号类型码]: { authority_live: 0|1 } }。 */
function readLiveAuthority(drAuth: unknown): number | null {
  if (!drAuth || typeof drAuth !== 'object') return null
  for (const value of Object.values(drAuth as Record<string, unknown>)) {
    if (value && typeof value === 'object' && 'authority_live' in (value as Record<string, unknown>)) {
      const raw = (value as Record<string, unknown>).authority_live
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}
