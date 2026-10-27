import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveTap, type TapCommentEvent } from './liveTap'
import { startBridgeServer } from './bridgeServer'
import { ScopeGuard, parseScope } from './scopeGuard'
import { TapIdentitySource } from './tapIdentitySource'

test('unverified creator role mappings cannot enable real buyin execution', async () => {
  await assert.rejects(startBridgeServer({ port: 0, token: 'synthetic-test-token-'.repeat(3),
    dataDir: 'synthetic-unused', storageStatePath: null, buyinReplyExecutionEnabled: true,
    buyinReply: { expectedOwnerId: 'owner', expectedExecutorId: 'executor', inputSelector: 'textarea', submitSelector: 'button',
      creatorRoleEvidence: { path: ['user_id'], value: 'owner' } } }), /buyin_creator_role_proof_unverified/)
})

const scope = { platform: 'douyin', account_id: 'synthetic-owner', room_id: '10000000000001', session_id: 'synthetic-session' }
const query = new URLSearchParams(scope).toString()
class OfflineTap extends LiveTap {
  override async start() {
    this.loggedIn = true
    this.roomId = scope.room_id
    this.compassAttached = true
    this.lastCommentPollAt = Date.now()
    this.facts = { userId: scope.account_id, buyinAccountId: 'synthetic-assistant', originUid: null, drAuth: { demo: { authority_live: 1 } }, observedAt: '2026-01-01T00:00:00.000Z' }
    this.catalog = { version: 1, roomId: scope.room_id, observedAt: new Date().toISOString(), items: [] }
  }
  push(event: TapCommentEvent) { (this as unknown as { emit(e: TapCommentEvent): void }).emit(event) }
  switchRoom(room: string | null) { (this as unknown as { observeRoom(r: string | null): void }).observeRoom(room) }
}

test('health remains readable and collector refresh remains stopped after a platform restriction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-stop-'))
  const token = 'synthetic-test-token-'.repeat(3)
  let tap!: OfflineTap
  const bridge = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: 'synthetic',
    log: () => {}, tapFactory: options => (tap = new OfflineTap(options)) })
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${bridge.port}${path}`,
    { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
  try {
    tap.markPlatformRestriction('host_rate_limited')
    for (let i = 0; i < 2; i++) {
      const health = await request('/health')
      assert.equal(health.status, 200)
      assert.equal((await health.json() as any).restriction_code, 'host_rate_limited')
      const refresh = await request('/collector/refresh', { method: 'POST' })
      assert.equal(refresh.status, 409)
      assert.equal((await refresh.json() as any).error_code, 'host_rate_limited')
    }
  } finally { await bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('scope registration cannot be stolen, misreleased, or accepted without observed identity', () => {
  const observed = { loggedIn: true, accountId: scope.account_id as string | null, roomId: scope.room_id as string | null }
  const guard = new ScopeGuard(() => observed)
  const current = parseScope(scope)
  guard.register(current)
  guard.register(current)
  assert.throws(() => guard.register({ ...current, sessionId: 'other' }), /busy/)
  assert.throws(() => guard.release({ ...current, sessionId: 'other' }), /mismatch/)
  observed.roomId = null
  assert.throws(() => guard.assertRegistered(current), /unproven/)
  guard.release(current)
  assert.equal(guard.current, null)
  for (const invalid of [{}, { ...scope, room_id: '' }, { ...scope, platform: 'other' }]) assert.throws(() => parseScope(invalid))
})

test('real HTTP routes reject wrong scope, invalid bodies, foreign origin and mismatched catalog; release closes SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-safety-'))
  const token = 'synthetic-test-token-'.repeat(3)
  let tap!: OfflineTap
  const bridge = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: 'synthetic', log: () => {}, tapFactory: options => (tap = new OfflineTap(options)) })
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${bridge.port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
  let stream: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let refreshes = 0
    tap.refreshConsole = async () => { refreshes++ }
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/collector/refresh`, { method: 'POST' })).status, 401)
    assert.equal(refreshes, 0)
    assert.equal((await request('/collector/refresh', { method: 'POST' })).status, 200)
    assert.equal(refreshes, 1)
    assert.equal((await request('/health', { headers: { origin: 'https://foreign.invalid' } })).status, 403)
    assert.equal((await request('/sessions')).status, 405)
    assert.equal((await request('/sessions', { method: 'POST', body: '{invalid' })).status, 400)
    assert.equal((await request('/sessions', { method: 'POST', body: JSON.stringify({ ...scope, padding: 'x'.repeat(66000) }) })).status, 413)
    assert.equal((await request(`/catalog?${query}`)).status, 409)
    assert.equal((await request(`/capabilities?${query.replace(scope.room_id, '10000000000002')}`)).status, 409)
    assert.equal((await request('/sessions', { method: 'POST', body: JSON.stringify(scope) })).status, 200)
    assert.equal((await request('/sessions', { method: 'POST', body: JSON.stringify({ ...scope, session_id: 'other' }) })).status, 409)
    assert.equal((await request(`/catalog?${query}`)).status, 200)
    tap.lastCommentPollAt = Date.now() - 61_000
    assert.equal((await request(`/events?${query}`)).status, 503)
    tap.lastCommentPollAt = Date.now()
    tap.catalog!.roomId = '10000000000002'
    assert.equal((await request(`/catalog?${query}`)).status, 503)
    assert.equal((await request(`/sessions?${query.replace('synthetic-session', 'other')}`, { method: 'DELETE' })).status, 409)
    stream = (await request(`/events?${query}`)).body!.getReader()
    await stream.read()
    tap.push({ roomId: scope.room_id, id: 'synthetic-event', nickname: 'viewer', text: 'synthetic question', occurredAt: new Date().toISOString(), kind: 'comment' })
    assert.match(new TextDecoder().decode((await stream.read()).value), /synthetic-event/)
    assert.equal((await request(`/sessions?${query}`, { method: 'DELETE' })).status, 200)
    assert.equal((await stream.read()).done, true)
    assert.equal((await request(`/catalog?${query}`)).status, 409)
  } finally {
    await stream?.cancel()
    await bridge.stop()
    assert.ok(dir.startsWith(join(tmpdir(), 'bridge-safety-')))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('room changes clear prior catalog, replay and capability counts; old room events are ignored', async () => {
  const tap = new OfflineTap({ storageStatePath: 'synthetic' })
  await tap.start()
  const base = { roomId: scope.room_id, nickname: 'viewer', text: 'synthetic', occurredAt: new Date().toISOString(), kind: 'comment' as const }
  tap.push({ ...base, id: 'one' }); tap.push({ ...base, id: 'two' })
  assert.equal(tap.recent('one').length, 1)
  tap.switchRoom('10000000000002')
  assert.equal(tap.catalog, null)
  assert.equal(tap.commentCount, 0)
  assert.equal(tap.recent('one').length, 0)
  assert.equal(tap.eventSourceHealthy, false)
  tap.push({ ...base, id: 'late' })
  assert.equal(tap.commentCount, 0)
})

test('identity observations retain original time and never invent role/permissions from cached getUser', async () => {
  const tap = new OfflineTap({ storageStatePath: 'synthetic' })
  await tap.start()
  let registered: ReturnType<typeof parseScope> | null = parseScope(scope)
  const source = new TapIdentitySource(tap, () => registered)
  await source.withContext('buyin', async ctx => {
    const seen = await ctx.read() as { observedAt: string; roleVerified: boolean; permissions: string[] }
    assert.equal(seen.observedAt, tap.facts!.observedAt)
    assert.equal(seen.roleVerified, false)
    assert.deepEqual(seen.permissions, [])
    registered = null
    await assert.rejects(() => ctx.read(), /context_changed/)
  })
  await assert.rejects(() => source.withContext('douyin_room', async () => {}), /unprovisioned/)
})
