/** One collector serves one explicitly registered room/session. Never echo an arbitrary request scope. */
export interface RegisteredScope { platform: string; accountId: string; roomId: string; sessionId: string }
export interface ObservedScope { loggedIn: boolean; accountId: string | null; roomId: string | null }

export function parseScope(input: Record<string, unknown>): RegisteredScope {
  const values = ['platform', 'account_id', 'room_id', 'session_id'].map(key => input[key])
  if (values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value))) {
    throw new Error('bridge_scope_invalid')
  }
  const [platform, accountId, roomId, sessionId] = values as string[]
  if (platform !== 'douyin') throw new Error('bridge_scope_mismatch')
  return { platform, accountId, roomId, sessionId }
}

export function sameScope(a: RegisteredScope | null, b: RegisteredScope): boolean {
  return !!a && a.platform === b.platform && a.accountId === b.accountId && a.roomId === b.roomId && a.sessionId === b.sessionId
}

export class ScopeGuard {
  current: RegisteredScope | null = null
  constructor(private readonly observed: () => ObservedScope) {}
  assertObserved(scope: RegisteredScope): void {
    const actual = this.observed()
    if (!actual.loggedIn || !actual.accountId || !actual.roomId) throw new Error('bridge_scope_unproven')
    if (scope.platform !== 'douyin' || scope.accountId !== actual.accountId || scope.roomId !== actual.roomId) throw new Error('bridge_scope_mismatch')
  }
  assertRegistered(scope: RegisteredScope): void {
    if (!sameScope(this.current, scope)) throw new Error('bridge_session_mismatch')
    this.assertObserved(scope)
  }
  register(scope: RegisteredScope): void {
    this.assertObserved(scope)
    if (this.current && !sameScope(this.current, scope)) throw new Error('bridge_session_busy')
    this.current = { ...scope }
  }
  release(scope: RegisteredScope): void {
    // Release still works after logout, but an unrelated caller may never release this session.
    if (!sameScope(this.current, scope)) throw new Error('bridge_session_mismatch')
    this.current = null
  }
}
