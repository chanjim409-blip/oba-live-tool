import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectStableCreatorEvidence } from '../../../scripts/probeCreatorObservation'
import { ProbeRestrictionClient } from '../../../scripts/probeRestrictionClient'
import type { LiveTap } from './liveTap'

function fixture() {
  let clock = Date.parse('2026-10-27T00:00:00Z')
  let generation = 1, identity = { userId: 'synthetic-old', observedAt: new Date(clock).toISOString() }
  let data = { user_role: 1 }, room = 'old-room', roomAt = clock, restricted = false
  let onWait = () => {}, onEval = () => {}, evaluations = 0, refreshRequests = 0
  const page = { locator: () => ({ first: () => ({ waitFor: async () => { onWait() } }) }),
    evaluate: async () => { evaluations++; const value = generation; onEval(); return {
      inputCount: value, inputVisible: true, inputEditable: true, submitCount: value, submitVisible: true, submitDisabled: false } } }
  const tap = { identityProbeSummary: async () => ({ available: true, restricted, host: 'buyin.jinritemai.com', path: '/dashboard/live/control' }),
    replyContext: () => ({ page, generation, facts: identity, identityData: data, loggedIn: true, roomId: room, roomObservedAt: roomAt }),
    refreshIdentity: async () => { refreshRequests++ } } as unknown as Pick<LiveTap, 'identityProbeSummary' | 'replyContext'>
  const navigate = () => { generation++; identity = { userId: 'synthetic-new', observedAt: new Date(clock).toISOString() }; data = { user_role: 2 }; room = 'new-room'; roomAt = clock }
  return { tap, navigate, restrict: () => { restricted = true }, evaluations: () => evaluations, requests: () => refreshRequests,
    setWait: (fn: () => void) => { onWait = fn }, setEval: (fn: () => void) => { onEval = fn },
    staleRoom: () => { roomAt = clock - 31_000 }, staleIdentity: () => { identity.observedAt = new Date(clock - 31_000).toISOString() },
    opts: { now: () => clock, sleep: async (ms: number) => { clock += ms }, timeoutMs: 5000 } }
}

test('SPA change during render discards old identity and old room, without extra requests', async () => {
  const f = fixture()
  f.setWait(() => { f.setWait(() => {}); f.navigate() })
  const result = await collectStableCreatorEvidence(f.tap, f.opts)
  assert.equal(result.context.facts?.userId, 'synthetic-new')
  assert.equal(result.context.roomId, 'new-room')
  assert.equal(result.candidateControls.inputCount, 2)
  assert.equal(f.requests(), 0)
})

test('SPA change during DOM observation discards both controls and old identity', async () => {
  const f = fixture()
  f.setEval(() => { f.setEval(() => {}); f.navigate() })
  const result = await collectStableCreatorEvidence(f.tap, f.opts)
  assert.equal(result.context.facts?.userId, 'synthetic-new')
  assert.equal(result.context.roomId, 'new-room')
  assert.equal(result.candidateControls.inputCount, 2)
  assert.equal(result.candidateControls.submitCount, 2)
  assert.ok(f.evaluations() >= 2)
})

test('captcha and permission denial stop before any DOM collection or extra request', async () => {
  const f = fixture()
  f.setWait(() => f.restrict())
  await assert.rejects(collectStableCreatorEvidence(f.tap, f.opts), /platform_verification_required/)
  assert.equal(f.evaluations(), 0)
  assert.equal(f.requests(), 0)
  const d = fixture()
  const denied = { ...d.tap, replyContext: () => { throw new Error('host_permission_denied') } }
  await assert.rejects(collectStableCreatorEvidence(denied, d.opts), /host_permission_denied/)
})

test('stale room becomes unknown and stale identity never yields evidence', async () => {
  const f = fixture(); f.staleRoom()
  assert.equal((await collectStableCreatorEvidence(f.tap, f.opts)).context.roomId, null)
  const stale = fixture(); stale.staleIdentity()
  await assert.rejects(collectStableCreatorEvidence(stale.tap, stale.opts), /identity_observation_expired/)
  assert.equal(stale.requests(), 0)
})

test('local host restriction gate fails closed for missing route, malformed state and latched stop', async () => {
  const token = 'synthetic-token-'.repeat(3)
  const noRoute = new ProbeRestrictionClient(token, 9310, async () => new Response('', { status: 404 }))
  await assert.rejects(noRoute.assertAllowed(), /host_restriction_gate_unavailable/)
  const malformed = new ProbeRestrictionClient(token, 9310, async () => Response.json({}))
  await assert.rejects(malformed.assertAllowed(), /host_restriction_gate_unavailable/)
  const stopped = new ProbeRestrictionClient(token, 9310, async () => Response.json({ restriction_code: 'host_rate_limited' }))
  await assert.rejects(stopped.assertAllowed(), /host_rate_limited/)
})

test('restriction reporting uses authenticated local host, checks receipt and never reveals token', async () => {
  const token = 'synthetic-token-'.repeat(3); const requests: { url: string; method: string; body: string | undefined }[] = []
  const client = new ProbeRestrictionClient(token, 9310, async (input, options) => {
    requests.push({ url: String(input), method: options?.method ?? '', body: options?.body as string | undefined })
    assert.equal((options?.headers as Record<string, string>).authorization, `Bearer ${token}`)
    return Response.json({ restriction_code: options?.method === 'POST' ? 'host_platform_restricted' : null })
  })
  await client.assertAllowed(); await client.report('host_platform_restricted')
  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:9310/collector/restriction', method: 'GET', body: undefined },
    { url: 'http://127.0.0.1:9310/collector/restriction', method: 'POST', body: '{"code":"host_platform_restricted"}' }])
  assert.equal(JSON.stringify(requests).includes(token), false)
  const badAck = new ProbeRestrictionClient(token, 9310, async () => Response.json({ restriction_code: null }))
  await assert.rejects(badAck.report('host_platform_restricted'), /host_restriction_gate_unavailable/)
})

test('remote stop prevents any page inspection', async () => {
  const f = fixture()
  await assert.rejects(collectStableCreatorEvidence(f.tap, { ...f.opts,
    checkPlatformGate: async () => { throw new Error('host_rate_limited') } }), /host_rate_limited/)
  assert.equal(f.evaluations(), 0)
  assert.equal(f.requests(), 0)
})
