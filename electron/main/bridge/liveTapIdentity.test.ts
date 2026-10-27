import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { LiveTap } from './liveTap'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(identityOnly = false) {
  const tap = new LiveTap({ storageStatePath: 'synthetic', identityOnly })
  const page = new EventEmitter() as any
  const frame = {}
  page.mainFrame = () => frame
  page.isClosed = () => false
  page.waitForSelector = async () => ({})
  page.evaluate = async () => true
  let next = { user_id: 'synthetic-owner', buyin_account_id: 'synthetic-executor', login_user_id: 'synthetic-login-one' }
  let refreshes = 0
  page.request = { get: async () => { refreshes++; return { ok: () => true, status: () => 200, json: async () => ({ data: next }) } } }
  const internals = tap as any
  internals.consolePage = page
  internals.attachConsole(page)
  const request = () => { const r = {}; page.emit('request', r); return r }
  const respond = (r: object, host = 'buyin.jinritemai.com') => page.emit('response', {
    request: () => r, url: () => `https://${host}/api/anchor/index/getUser`,
    headers: () => ({ 'content-type': 'application/json' }), json: async () => ({ data: next }),
  })
  return { tap, page, frame, request, respond, refreshes: () => refreshes,
    changeExecutor: () => { next = { ...next, buyin_account_id: 'synthetic-other' } },
    changeLogin: () => { next = { ...next, login_user_id: 'synthetic-login-two' } } }
}

test('login user change alone invalidates the room and is retained as opaque identity', async () => {
  const f = fixture()
  f.respond(f.request()); await tick()
  assert.equal(f.tap.facts?.loginUserId, 'synthetic-login-one')
  f.tap.roomId = '10000000000001'
  f.changeLogin()
  await f.tap.refreshIdentity()
  assert.equal(f.tap.currentRoomId, null)
  assert.equal(f.tap.facts?.loginUserId, 'synthetic-login-two')
})

test('identity-only observations never actively refresh on SPA navigation', async () => {
  const f = fixture(true)
  f.respond(f.request()); await tick()
  f.page.emit('framenavigated', f.frame)
  await tick()
  assert.equal(f.refreshes(), 0)
  assert.equal(f.tap.facts, null)
})

test('SPA navigation re-reads observed identity and restores login without reusing invalidated facts', async () => {
  const f = fixture()
  f.respond(f.request()); await tick()
  assert.equal(f.tap.loggedIn, true)
  f.page.emit('framenavigated', f.frame)
  assert.equal(f.tap.loggedIn, false)
  assert.equal(f.tap.facts, null)
  await tick()
  assert.equal(f.refreshes(), 1)
  assert.equal(f.tap.loggedIn, true)
  assert.equal((f.tap.facts as { userId: string | null } | null)?.userId, 'synthetic-owner')
})

test('old navigation responses and foreign hosts cannot restore identity', async () => {
  const f = fixture()
  const old = f.request()
  f.page.emit('framenavigated', f.frame)
  f.respond(old); await tick()
  f.respond(f.request(), 'buyin.jinritemai.com.invalid'); await tick()
  assert.equal(f.tap.loggedIn, false)
  assert.equal(f.tap.facts, null)
  assert.equal(f.refreshes(), 0)
})

test('executor switch clears room and failed refresh clears identity', async () => {
  const f = fixture()
  f.respond(f.request()); await tick()
  f.tap.roomId = '10000000000001'
  f.changeExecutor()
  await f.tap.refreshIdentity()
  assert.equal(f.tap.currentRoomId, null)
  f.page.request.get = async () => { throw new Error('offline') }
  await f.tap.refreshIdentity()
  assert.equal(f.tap.loggedIn, false)
  assert.equal(f.tap.facts, null)
})

test('identity platform denial invalidates evidence and stops all further refresh or reload', async () => {
  for (const [status, code] of [[401, 'host_login_expired'], [403, 'host_permission_denied'], [429, 'host_rate_limited']] as const) {
    const f = fixture()
    f.respond(f.request()); await tick()
    let requests = 0, reloads = 0, closes = 0
    f.page.close = async () => { closes++ }
    f.page.reload = async () => { reloads++ }
    f.page.request.get = async () => { requests++; return { ok: () => false, status: () => status, json: async () => ({}) } }
    await assert.rejects(f.tap.refreshIdentity(), (e: any) => e.code === code)
    assert.equal(f.tap.restrictionCode, code)
    assert.equal(f.tap.loggedIn, false)
    assert.equal(f.tap.facts, null)
    await assert.rejects(f.tap.refreshIdentity(), (e: any) => e.code === code)
    await assert.rejects(f.tap.refreshConsole(), (e: any) => e.code === code)
    assert.equal(requests, 1)
    assert.equal(reloads, 0)
    assert.equal(closes, 1)
  }
})

test('room response denial is latched before JSON parsing and cannot be refreshed again', async () => {
  for (const [status, code] of [[401, 'host_login_expired'], [403, 'host_permission_denied'], [429, 'host_rate_limited']] as const) {
    const f = fixture()
    f.respond(f.request()); await tick()
    f.page.url = () => 'https://buyin.jinritemai.com/dashboard/live/control'
    const internals = f.tap as any
    internals.playinfoUrl = 'https://buyin.jinritemai.com/livepc/playinfo'
    let requests = 0, parsed = 0
    f.page.request.get = async (url: string) => {
      requests++
      return url.includes('getUser')
        ? { ok: () => true, status: () => 200, json: async () => ({ data: { user_id: 'synthetic-owner', buyin_account_id: 'synthetic-executor' } }) }
        : { ok: () => false, status: () => status, json: async () => { parsed++; throw new Error('not json') } }
    }
    await assert.rejects(f.tap.refreshReplyEvidence(), (e: any) => e.code === code)
    assert.equal(parsed, 0)
    assert.equal(f.tap.restrictionCode, code)
    await assert.rejects(f.tap.refreshReplyEvidence(), (e: any) => e.code === code)
    assert.equal(requests, 2)
  }
})

test('observed non-JSON restriction also latches and blocks automatic SPA refresh', async () => {
  for (const [status, code] of [[401, 'host_login_expired'], [403, 'host_permission_denied'], [429, 'host_rate_limited']] as const) {
    const f = fixture()
    f.respond(f.request()); await tick()
    f.page.emit('response', { request: () => f.request(), url: () => 'https://buyin.jinritemai.com/livepc/playinfo',
      status: () => status, headers: () => ({ 'content-type': 'text/html' }) })
    await tick()
    assert.equal(f.tap.restrictionCode, code)
    f.page.emit('framenavigated', f.frame)
    await tick()
    assert.equal(f.refreshes(), 0)
  }
})
