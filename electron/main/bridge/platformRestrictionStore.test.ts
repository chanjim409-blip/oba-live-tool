import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHostBridgeDb } from './sqliteDb'
import { PlatformRestrictionStore } from './platformRestrictionStore'
import { LiveTap } from './liveTap'
import { startBridgeServer } from './bridgeServer'
import type { RoomBrowserDriver } from './roomBrowserDriver'

test('manual inspection reports a fixed failure stage without leaking raw error or clearing stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-inspection-failure-'))
  const token = 'synthetic-token-'.repeat(4)
  const db = openHostBridgeDb(join(dir, 'host-identity.sqlite'))
  new PlatformRestrictionStore(db.db).record('host_platform_restricted'); db.close()
  let opens = 0
  const host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: null,
    replyBrowser: { profileDir: 'synthetic', executablePath: 'synthetic', capturePaths: [], anchorName: 'synthetic',
      expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' },
    inspectionFactory: () => ({ status: 'failed' as const, failureStage: 'browser_launch' as const,
      open: async () => { opens++; throw new Error('synthetic-secret-not-for-clients') }, close: async () => {} }), log: () => {} })
  const url = `http://127.0.0.1:${host.port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  try {
    const response = await fetch(`${url}/reply/manual-inspection`, { method: 'POST', headers, body: JSON.stringify({ confirmed: true }) })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error_code: 'bridge_inspection_open_failed', failure_stage: 'browser_launch', restriction_code: 'host_platform_restricted' })
    const status = await fetch(`${url}/reply/manual-inspection`, { headers })
    const body = await status.json() as Record<string, unknown>
    assert.equal(body.failure_stage, 'browser_launch')
    assert.doesNotMatch(JSON.stringify(body), /synthetic-secret/)
    const retry = await fetch(`${url}/reply/manual-inspection`, { method: 'POST', headers, body: JSON.stringify({ confirmed: true }) })
    assert.equal(retry.status, 409)
    assert.equal(opens, 1)
    assert.equal((await (await fetch(`${url}/collector/restriction`, { headers })).json() as { restriction_code: string }).restriction_code, 'host_platform_restricted')
  } finally { await host.stop(); rmSync(dir, { recursive: true, force: true }) }
})

test('manual inspection is authenticated, explicitly requested and preserves stop across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-inspection-'))
  const token = 'synthetic-token-'.repeat(4)
  const db = openHostBridgeDb(join(dir, 'host-identity.sqlite'))
  new PlatformRestrictionStore(db.db).record('host_platform_restricted')
  db.close()
  let opens = 0, closes = 0, release!: () => void, started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  let status: 'idle' | 'open' | 'closed' = 'idle'
  const fake = { get status() { return status }, open: async (check: () => void) => {
    opens++; check(); started(); await pending; check(); status = 'open'
  }, close: async () => { closes++; status = 'closed' } }
  const replyBrowser = { profileDir: 'synthetic', executablePath: 'synthetic', capturePaths: [], anchorName: 'synthetic',
    expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' }
  try {
    const host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: null,
      replyBrowser, inspectionFactory: () => fake, log: () => {} })
    const url = `http://127.0.0.1:${host.port}`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const post = (body: unknown, extra = {}) => fetch(`${url}/reply/manual-inspection`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
    try {
      assert.equal((await fetch(`${url}/reply/manual-inspection`, { method: 'POST' })).status, 401)
      assert.equal((await post({ confirmed: true }, { origin: 'https://foreign.invalid' })).status, 403)
      assert.equal((await post({ confirmed: true, extra: true })).status, 400)
      const first = post({ confirmed: true })
      await startedPromise
      assert.equal((await post({ confirmed: true })).status, 409)
      assert.equal(opens, 1)
      release()
      const response = await first
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { opened: true, mode: 'human_inspection', restriction_code: 'host_platform_restricted' })
      status = 'closed' // The person closes the inspection window; this never clears the stop.
      const inspectionState = await fetch(`${url}/reply/manual-inspection`, { headers })
      assert.deepEqual(await inspectionState.json(), { mode: 'human_inspection', state: 'closed', restriction_code: 'host_platform_restricted' })
      const state = await fetch(`${url}/collector/restriction`, { headers })
      assert.deepEqual(await state.json(), { restriction_code: 'host_platform_restricted' })
      assert.equal((await post({ confirmed: true })).status, 409)
    } finally { release(); await host.stop() }
    assert.equal(closes, 1)
    const reopened = openHostBridgeDb(join(dir, 'host-identity.sqlite'))
    try {
      assert.equal(new PlatformRestrictionStore(reopened.db).read(), 'host_platform_restricted')
      const history = reopened.db.prepare('SELECT event FROM buyin_restriction_history ORDER BY rowid').all<{ event: string }>()
      assert.deepEqual(history.map(row => row.event), ['stopped', 'inspection_requested', 'inspection_opened'])
    } finally { reopened.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('manual inspection never starts when stop is absent or a send switch is enabled', async () => {
  for (const mode of ['no-stop', 'send-enabled']) {
    const dir = mkdtempSync(join(tmpdir(), 'buyin-inspection-'))
    const token = 'synthetic-token-'.repeat(4)
    if (mode === 'send-enabled') {
      const db = openHostBridgeDb(join(dir, 'host-identity.sqlite'))
      new PlatformRestrictionStore(db.db).record('host_platform_restricted'); db.close()
    }
    let opens = 0
    const host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: null,
      replyExecutionEnabled: mode === 'send-enabled',
      replyBrowser: { profileDir: 'synthetic', executablePath: 'synthetic', capturePaths: [], anchorName: 'synthetic',
        expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' },
      // No-stop startup would normally launch the reply driver; supply a failing fake.
      replyDriverFactory: () => ({ start: async () => { throw new Error('synthetic') }, stop: async () => {} }) as never,
      inspectionFactory: () => ({ status: 'idle', open: async () => { opens++ }, close: async () => {} }), log: () => {} })
    try {
      const response = await fetch(`http://127.0.0.1:${host.port}/reply/manual-inspection`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) })
      assert.equal(response.status, 409)
      assert.equal(opens, 0)
    } finally { await host.stop(); rmSync(dir, { recursive: true, force: true }) }
  }
})

test('platform stop survives process/database reopen and prevents any browser launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-stop-'))
  const file = join(dir, 'host-identity.sqlite')
  let first = openHostBridgeDb(file)
  try {
    const stop = new PlatformRestrictionStore(first.db, () => 1000)
    assert.equal(stop.read(), null)
    stop.record('host_rate_limited')
    stop.record('host_permission_denied')
    assert.equal(stop.read(), 'host_rate_limited')
    first.close()
    const reopened = openHostBridgeDb(file)
    try {
      const persisted = new PlatformRestrictionStore(reopened.db)
      const tap = new LiveTap({ storageStatePath: 'not-a-file', restrictionStore: persisted })
      assert.equal(tap.restrictionCode, 'host_rate_limited')
      // A restriction error, before even consulting a missing storageState file or launching Chrome.
      await assert.rejects(() => tap.start(), /host_rate_limited/)
      const events = reopened.db.prepare('SELECT event,code FROM buyin_restriction_history').all<{ event: string; code: string }>()
      assert.equal(events.length, 1)
      assert.equal(events[0]?.event, 'stopped')
      assert.equal(events[0]?.code, 'host_rate_limited')
    } finally { reopened.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('host restart serves a stopped health result without starting the owned collector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-host-stop-'))
  const file = join(dir, 'host-identity.sqlite')
  const opened = openHostBridgeDb(file)
  new PlatformRestrictionStore(opened.db).record('host_platform_restricted')
  opened.close()
  let started = 0
  const logs: string[] = []
  class OfflineTap extends LiveTap { override async start() { started++ } }
  const token = 'synthetic-token-'.repeat(4)
  try {
    const host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: 'not-a-file',
      tapFactory: options => new OfflineTap(options), log: value => logs.push(value),
      replyBrowser: { profileDir: 'synthetic', executablePath: '', capturePaths: [], anchorName: 'synthetic',
        expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' } })
    try {
      assert.equal(started, 0)
      const response = await fetch(`http://127.0.0.1:${host.port}/health`, { headers: { authorization: `Bearer ${token}` } })
      const body = await response.json() as { restriction_code: string; logged_in: boolean }
      assert.equal(body.restriction_code, 'host_platform_restricted')
      assert.equal(body.logged_in, false)
      assert.equal(started, 0)
      assert.equal(logs.some(value => value.includes('后台回复浏览器未就绪')), false)
    } finally { await host.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('authenticated probe may only report a stop; host persists it, cannot clear it and stays stopped after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-stop-report-'))
  const token = 'synthetic-token-'.repeat(4)
  let identityCalls = 0
  const identitySource = { async withContext<T>(): Promise<T> { identityCalls++; throw new Error('unexpected_identity_probe') } }
  try {
    let host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: null, identitySource, log: () => {} })
    const request = (method: string, body?: unknown, authorised = true) => fetch(`http://127.0.0.1:${host.port}/collector/restriction`, {
      method, headers: { ...(authorised ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    try {
      assert.equal((await request('POST', { code: 'host_rate_limited' }, false)).status, 401)
      assert.equal((await request('POST', { code: 'clear' })).status, 400)
      const response = await request('POST', { code: 'host_rate_limited' })
      assert.equal(response.status, 200)
      assert.equal((await response.json() as { restriction_code: string }).restriction_code, 'host_rate_limited')
      const query = new URLSearchParams({ platform: 'douyin', account_id: 'owner', room_id: 'room', session_id: 'session', surface: 'buyin' })
      const identity = await fetch(`http://127.0.0.1:${host.port}/identity?${query}`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(identity.status, 409)
      assert.equal((await identity.json() as { error_code: string }).error_code, 'host_rate_limited')
      assert.equal(identityCalls, 0)
    } finally { await host.stop() }
    let starts = 0
    class OfflineTap extends LiveTap { override async start() { starts++ } }
    host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: 'not-a-file',
      tapFactory: options => new OfflineTap(options), log: () => {} })
    try {
      assert.equal(starts, 0)
      const response = await request('GET')
      assert.equal((await response.json() as { restriction_code: string }).restriction_code, 'host_rate_limited')
      const refresh = await fetch(`http://127.0.0.1:${host.port}/reply/refresh`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      assert.equal(refresh.status, 409)
      assert.equal((await refresh.json() as { error_code: string }).error_code, 'host_rate_limited')
    } finally { await host.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('corrupt stored state is rejected rather than treated as cleared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-stop-invalid-'))
  const db = openHostBridgeDb(join(dir, 'host-identity.sqlite'))
  try {
    const stop = new PlatformRestrictionStore(db.db)
    db.db.prepare('INSERT INTO buyin_restriction_state(singleton,code,observed_at) VALUES(1,?,?)').run('unknown-value', 'synthetic')
    assert.throws(() => stop.read(), /buyin_restriction_state_invalid/)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('failed persistence keeps this process fail-closed and reports storage failure', async () => {
  const badStore = { read: () => null, record: () => { throw new Error('disk failure') } } as unknown as PlatformRestrictionStore
  const tap = new LiveTap({ storageStatePath: 'not-a-file', restrictionStore: badStore })
  tap.markPlatformRestriction('host_rate_limited')
  assert.equal(tap.restrictionCode, 'host_restriction_store_unavailable')
  await assert.rejects(tap.start(), /host_restriction_store_unavailable/)
})

test('probe stop report with no collector fails closed on disk write error and stops reply driver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-report-disk-error-'))
  const token = 'synthetic-token-'.repeat(4)
  let starts = 0, stops = 0, reads = 0
  const logs: string[] = []
  const fakeStore = { read: () => null, record: () => { throw new Error('synthetic-secret-disk-detail') } } as unknown as PlatformRestrictionStore
  const fakeDriver = { start: async () => { starts++ }, stop: async () => { stops++ }, manualVerificationActive: false } as unknown as RoomBrowserDriver
  const identitySource = { async withContext<T>(): Promise<T> { reads++; throw new Error('unexpected') } }
  const replyBrowser = { profileDir: 'synthetic', executablePath: '', capturePaths: [], anchorName: 'synthetic',
    expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' }
  try {
    const host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: null, identitySource,
      restrictionStoreFactory: () => fakeStore, replyDriverFactory: () => fakeDriver, replyBrowser,
      replyExecutionEnabled: true, log: value => logs.push(value) })
    try {
      assert.equal(starts, 1)
      const base = `http://127.0.0.1:${host.port}`
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const report = await fetch(`${base}/collector/restriction`, { method: 'POST', headers, body: JSON.stringify({ code: 'host_rate_limited' }) })
      assert.equal(report.status, 409)
      assert.deepEqual(await report.json(), { error_code: 'host_restriction_store_unavailable' })
      assert.equal(stops, 1)
      const check = await fetch(`${base}/collector/restriction`, { headers })
      assert.deepEqual(await check.json(), { restriction_code: 'host_restriction_store_unavailable' })
      const health = await fetch(`${base}/health`, { headers })
      const status = await health.json() as { restriction_code: string; reply_execution_enabled: boolean }
      assert.equal(status.restriction_code, 'host_restriction_store_unavailable')
      assert.equal(status.reply_execution_enabled, false)
      const query = new URLSearchParams({ platform: 'douyin', account_id: 'owner', room_id: 'room', session_id: 'session', surface: 'buyin' })
      const identity = await fetch(`${base}/identity?${query}`, { headers })
      assert.equal(identity.status, 409)
      assert.deepEqual(await identity.json(), { error_code: 'host_restriction_store_unavailable' })
      assert.equal(reads, 0)
      const refresh = await fetch(`${base}/reply/refresh`, { method: 'POST', headers })
      assert.equal(refresh.status, 409)
      assert.deepEqual(await refresh.json(), { error_code: 'host_restriction_store_unavailable' })
      assert.equal(logs.some(value => value.includes('synthetic-secret-disk-detail')), false)
    } finally { await host.stop() }
    let restartedCollector = 0
    class OfflineTap extends LiveTap { override async start() { restartedCollector++ } }
    const restarted = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: 'not-a-file',
      tapFactory: options => new OfflineTap(options), replyBrowser, replyDriverFactory: () => fakeDriver, log: () => {} })
    try {
      assert.equal(restartedCollector, 0)
      assert.equal(starts, 1)
      const response = await fetch(`http://127.0.0.1:${restarted.port}/collector/restriction`, { headers: { authorization: `Bearer ${token}` } })
      assert.deepEqual(await response.json(), { restriction_code: 'host_restriction_store_unavailable' })
    } finally { await restarted.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('store read failure latches and reports a fixed code without exposing the original error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-read-disk-error-'))
  const token = 'synthetic-token-'.repeat(4)
  let broken = false, stops = 0
  const fakeStore = { read: () => { if (broken) throw new Error('synthetic-secret-read-detail'); return null }, record: () => {} } as unknown as PlatformRestrictionStore
  const fakeDriver = { start: async () => {}, stop: async () => { stops++ }, manualVerificationActive: false } as unknown as RoomBrowserDriver
  const logs: string[] = []
  try {
    const host = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: null,
      restrictionStoreFactory: () => fakeStore, replyDriverFactory: () => fakeDriver,
      replyBrowser: { profileDir: 'synthetic', executablePath: '', capturePaths: [], anchorName: 'synthetic',
        expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' }, log: value => logs.push(value) })
    try {
      broken = true
      const headers = { authorization: `Bearer ${token}` }
      const response = await fetch(`http://127.0.0.1:${host.port}/collector/restriction`, { headers })
      assert.deepEqual(await response.json(), { restriction_code: 'host_restriction_store_unavailable' })
      assert.equal(stops, 1)
      broken = false // A transient storage recovery never clears the volatile stop.
      const retry = await fetch(`http://127.0.0.1:${host.port}/collector/restriction`, { headers })
      assert.deepEqual(await retry.json(), { restriction_code: 'host_restriction_store_unavailable' })
      assert.equal(logs.some(value => value.includes('synthetic-secret-read-detail')), false)
    } finally { await host.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('startup store failures produce a fixed error before launching any browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'buyin-start-disk-error-'))
  let starts = 0
  const fakeStore = { read: () => { throw new Error('synthetic-secret-start-detail') } } as unknown as PlatformRestrictionStore
  try {
    await assert.rejects(startBridgeServer({ port: 0, token: 'synthetic-token-'.repeat(4), dataDir: dir, storageStatePath: null,
      restrictionStoreFactory: () => fakeStore, replyDriverFactory: () => { starts++; throw new Error('unexpected') },
      replyBrowser: { profileDir: 'synthetic', executablePath: '', capturePaths: [], anchorName: 'synthetic',
        expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' } }),
      (error: unknown) => error instanceof Error && error.message === 'host_restriction_store_unavailable')
    assert.equal(starts, 0)
    const token = 'synthetic-token-'.repeat(4)
    const restarted = await startBridgeServer({ port: 0, token, dataDir: dir, storageStatePath: null,
      replyDriverFactory: () => { starts++; throw new Error('unexpected') },
      replyBrowser: { profileDir: 'synthetic', executablePath: '', capturePaths: [], anchorName: 'synthetic',
        expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic' } })
    try {
      assert.equal(starts, 0)
      const response = await fetch(`http://127.0.0.1:${restarted.port}/collector/restriction`, { headers: { authorization: `Bearer ${token}` } })
      assert.deepEqual(await response.json(), { restriction_code: 'host_restriction_store_unavailable' })
    } finally { await restarted.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
