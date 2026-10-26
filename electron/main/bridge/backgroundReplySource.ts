import { createHash } from 'node:crypto'
import type { AccountSurface, IdentityObservation } from './vendor/accountGovernance'
import { HostIdentityError, type HostAction, type HostIdentitySource, type HostIdentityContext } from './vendor/hostIdentity'
import type { Receipt } from './vendor/contracts'
import { sameScope, type RegisteredScope } from './scopeGuard'

export interface ReplySnapshot {
  ownerId: string
  roomId: string
  executorId: string
  live: boolean
  admin: boolean
  canSend: boolean
  blocked: boolean
  generation: string
  observedAt: number
}

/** Browser/HTTP drivers must inspect actual state, and must never retry submit on an unknown outcome. */
export interface BackgroundReplyDriver {
  snapshot(signal?: AbortSignal): Promise<ReplySnapshot>
  submit(text: string, beforeSubmit: () => Promise<void>, signal?: AbortSignal): Promise<Omit<Receipt, 'actionId'>>
}

export class BackgroundReplySource implements HostIdentitySource {
  private lastAttemptAt = -Infinity
  private halted = false
  constructor(private readonly driver: BackgroundReplyDriver,
    private readonly scope: () => RegisteredScope | null,
    private readonly expected: { ownerId: string; executorId: string; minIntervalMs: number },
    private readonly now: () => number = Date.now) {
    if (!expected.ownerId || !expected.executorId || expected.minIntervalMs < 5000) throw new Error('reply_configuration_invalid')
  }

  async withContext<T>(surface: AccountSurface, run: (context: HostIdentityContext) => Promise<T>): Promise<T> {
    if (surface !== 'douyin_room') throw new HostIdentityError('host_surface_unprovisioned')
    const scope = this.scope()
    if (!scope) throw new HostIdentityError('host_session_not_registered')
    let pinned: ReplySnapshot | null = null
    const assertCurrent = (signal?: AbortSignal) => {
      if (signal?.aborted) throw new HostIdentityError('host_request_cancelled')
      if (this.halted) throw new HostIdentityError('host_reply_halted')
      if (!sameScope(this.scope(), scope)) throw new HostIdentityError('host_context_changed')
    }
    const check = async (signal?: AbortSignal) => {
      assertCurrent(signal)
      const seen = await this.driver.snapshot(signal)
      // Registration/revocation may run while the driver waits for browser evidence.
      assertCurrent(signal)
      if (seen.blocked) { this.halted = true; throw new HostIdentityError('host_platform_restricted') }
      if (seen.ownerId !== this.expected.ownerId || seen.executorId !== this.expected.executorId
        || seen.roomId !== scope.roomId || !seen.live) throw new HostIdentityError('host_scope_mismatch')
      if (this.now() - seen.observedAt < 0 || this.now() - seen.observedAt > 30_000) throw new HostIdentityError('host_identity_stale')
      if (!seen.admin || !seen.canSend) throw new HostIdentityError('host_permission_denied')
      if (pinned && pinned.generation !== seen.generation) throw new HostIdentityError('host_context_changed')
      pinned = seen
      return seen
    }
    return run({
      read: async signal => {
        const seen = await check(signal)
        const observation: IdentityObservation = { ...scope, surface, executorId: seen.executorId,
          loginState: 'authenticated', role: 'room_admin', roleVerified: true, permissions: ['reply'],
          observedAt: new Date(seen.observedAt).toISOString(),
          identityRevision: createHash('sha256').update(JSON.stringify([seen.generation, seen.ownerId, seen.executorId, seen.roomId])).digest('hex'),
          executionGuard: 'identity_revision_v2', evidenceMode: 'platform' }
        return observation
      },
      execute: async (action: HostAction, signal?: AbortSignal) => {
        if (action.kind !== 'reply' || action.userId || action.productId || !action.text?.trim()
          || action.text.length > 500) throw new HostIdentityError('host_reply_target_unsupported')
        const beforeSubmit = async () => {
          await check(signal)
          if (this.now() >= Date.parse(action.deadlineAt)) throw new HostIdentityError('host_request_expired')
          if (action.platform !== scope.platform || action.accountId !== scope.accountId
            || action.roomId !== scope.roomId || action.sessionId !== scope.sessionId
            || action.identityGuard.executorId !== this.expected.executorId) throw new HostIdentityError('host_scope_mismatch')
          if (this.now() - this.lastAttemptAt < this.expected.minIntervalMs) throw new HostIdentityError('host_reply_rate_limited')
        }
        await beforeSubmit()
        let submitted = false
        let receipt: Omit<Receipt, 'actionId'>
        try { receipt = await this.driver.submit(action.text, async () => {
          if (submitted) throw new HostIdentityError('host_duplicate_submit')
          await beforeSubmit()
          this.lastAttemptAt = this.now()
          submitted = true
        }, signal) } catch (error) { if (submitted) this.halted = true; throw error }
        if (!submitted) throw new HostIdentityError('host_submit_guard_missing')
        // Unknown delivery or a platform rejection stops the channel until an operator investigates/restarts.
        if (receipt.status !== 'confirmed') this.halted = true
        return { ...receipt, actionId: action.actionId }
      },
    })
  }
}
