import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BackgroundReplySource, type BackgroundReplyDriver, type ReplySnapshot } from './backgroundReplySource'
import type { HostAction, HostIdentityContext } from './vendor/hostIdentity'

const now = Date.now()
const scope = { platform: 'douyin', accountId: 'collector-owner', roomId: '111', sessionId: 'test-session' }
const action: HostAction = { ...scope, actionId: 'test-reply', kind: 'reply', deadlineAt: new Date(now + 4000).toISOString(),
  text: 'Synthetic test only', productId: null, userId: null,
  identityGuard: { surface: 'douyin_room', executorId: '222', identityRevision: 'synthetic', bindingRevision: 1 } }
const snapshot: ReplySnapshot = { ownerId: '333', roomId: '111', executorId: '222', live: true, admin: true,
  canSend: true, blocked: false, generation: 'one', observedAt: now }
function setup() {
  let state = { ...snapshot }, sends = 0, time = now
  let selected: typeof scope | null = { ...scope }
  let before = async () => {}
  const driver: BackgroundReplyDriver = {
    snapshot: async () => ({ ...state }),
    submit: async (_text, guard) => { await before(); await guard(); sends++; return {
      status: 'uncertain', evidenceKind: 'click_only', evidenceRef: null,
      observedAt: new Date(time).toISOString(), errorCode: 'synthetic_unknown' } },
  }
  const source = new BackgroundReplySource(driver, () => selected,
    { ownerId: '333', executorId: '222', minIntervalMs: 15_000 }, () => time)
  return { source, driver, sends: () => sends, state: (patch: Partial<ReplySnapshot>) => { state = { ...state, ...patch } },
    scope: (value: typeof scope | null) => { selected = value }, time: (value: number) => { time = value },
    before: (fn: () => Promise<void>) => { before = fn } }
}

test('background reply requires current actor, room, platform role and fresh observations', async () => {
  for (const patch of [{ executorId: 'other' }, { ownerId: 'other' }, { roomId: 'other' }, { live: false },
    { admin: false }, { canSend: false }, { observedAt: now - 31_000 }, { blocked: true }]) {
    const env = setup(); env.state(patch)
    await assert.rejects(() => env.source.withContext('douyin_room', ctx => ctx.read()))
    assert.equal(env.sends(), 0)
  }
})

test('human verification blocks pending actions and cannot clear an attempted/unknown send', async () => {
  const env = setup()
  env.state({ blocked: true })
  await assert.rejects(() => env.source.withContext('douyin_room', ctx => ctx.read()), /platform_restricted/)
  env.source.beginManualVerification()
  env.state({ blocked: false })
  await assert.rejects(() => env.source.withContext('douyin_room', ctx => ctx.read()), /manual_verification_active/)
  env.source.completeManualVerification()
  await env.source.withContext('douyin_room', ctx => ctx.read())
  env.before(async () => { env.source.beginManualVerification() })
  await assert.rejects(() => env.source.withContext('douyin_room', ctx => ctx.execute(action)), /manual_verification_active/)
  assert.equal(env.sends(), 0)
  env.source.completeManualVerification()
  env.before(async () => {})
  assert.equal((await env.source.withContext('douyin_room', ctx => ctx.execute(action))).status, 'uncertain')
  assert.throws(() => env.source.beginManualVerification(), /requires_reconcile/)
  assert.throws(() => env.source.completeManualVerification(), /requires_reconcile/)
})

test('switching page/account or session while preparing text prevents the irreversible submit', async () => {
  for (const change of ['page', 'session', 'cancel', 'deadline']) {
    const env = setup(); const controller = new AbortController()
    env.before(async () => {
      if (change === 'page') env.state({ generation: 'two' })
      if (change === 'session') env.scope(null)
      if (change === 'cancel') controller.abort()
      if (change === 'deadline') env.time(now + 5000)
    })
    await assert.rejects(() => env.source.withContext('douyin_room', async ctx => {
      await ctx.read(); return ctx.execute(action, controller.signal)
    }))
    assert.equal(env.sends(), 0)
  }
})

test('unknown result or exception after submit halts further actions, even with different IDs', async () => {
  for (const throws of [false, true]) {
    const env = setup()
    if (throws) env.driver.submit = async (_text, guard) => { await guard(); throw new Error('lost response') }
    const run = () => env.source.withContext('douyin_room', async ctx => { await ctx.read(); return ctx.execute(action) })
    if (throws) await assert.rejects(run)
    else assert.equal((await run()).status, 'uncertain')
    await assert.rejects(() => env.source.withContext('douyin_room', ctx => ctx.execute({ ...action, actionId: 'another' })), /halted/)
  }
})

test('session released or replaced during the final awaited identity read prevents submit', async () => {
  for (const next of [null, { ...scope, sessionId: 'next-session' }]) {
    const env = setup()
    let reads = 0
    env.driver.snapshot = async () => {
      // read(), execute() preflight, then the driver's final beforeSubmit guard.
      if (++reads === 3) env.scope(next)
      return { ...snapshot }
    }
    await assert.rejects(() => env.source.withContext('douyin_room', async ctx => {
      await ctx.read()
      return ctx.execute(action)
    }), /host_context_changed/)
    assert.equal(env.sends(), 0)
  }
})

test('unsupported actions and native mentions are refused, not silently converted to plain text', async () => {
  for (const change of [{ kind: 'popup' as const }, { userId: 'viewer' }, { productId: 'product' }]) {
    const env = setup()
    await assert.rejects(() => env.source.withContext('douyin_room', ctx => ctx.execute({ ...action, ...change })), /unsupported/)
    assert.equal(env.sends(), 0)
  }
})

test('successful receipts still enforce a channel-wide minimum interval', async () => {
  const env = setup()
  env.driver.submit = async (_text, guard) => { await guard(); return { status: 'confirmed', evidenceKind: 'platform_ack',
    evidenceRef: 'synthetic-test-only', observedAt: new Date(now).toISOString(), errorCode: null } }
  const run = (ctx: HostIdentityContext) => ctx.execute(action)
  await env.source.withContext('douyin_room', run)
  await assert.rejects(() => env.source.withContext('douyin_room', run), /rate_limited/)
})
