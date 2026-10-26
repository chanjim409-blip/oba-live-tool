import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { LiveTap } from './liveTap'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const tap = new LiveTap({ storageStatePath: 'synthetic' })
  const page = new EventEmitter() as any
  const frame = {}
  page.mainFrame = () => frame
  page.isClosed = () => false
  page.waitForSelector = async () => ({})
  page.evaluate = async () => true
  let next = { user_id: 'synthetic-owner', buyin_account_id: 'synthetic-executor' }
  let refreshes = 0
  page.request = { get: async () => { refreshes++; return { ok: () => true, json: async () => ({ data: next }) } } }
  const internals = tap as any
  internals.consolePage = page
  internals.attachConsole(page)
  const request = () => { const r = {}; page.emit('request', r); return r }
  const respond = (r: object, host = 'buyin.jinritemai.com') => page.emit('response', {
    request: () => r, url: () => `https://${host}/api/anchor/index/getUser`,
    headers: () => ({ 'content-type': 'application/json' }), json: async () => ({ data: next }),
  })
  return { tap, page, frame, request, respond, refreshes: () => refreshes,
    changeExecutor: () => { next = { ...next, buyin_account_id: 'synthetic-other' } } }
}

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
