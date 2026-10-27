import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LiveTap } from './liveTap'
import { BuyinReplyDriver, matchesCreatorEvidence } from './buyinReplyDriver'
import { BackgroundReplySource } from './backgroundReplySource'
import { chromium } from 'playwright'

function fixture() {
  let clicks = 0, fills = 0, generation = 1, challenge = false
  const facts = { userId: 'owner', buyinAccountId: 'executor', drAuth: {}, observedAt: new Date().toISOString() }
  const page = { locator: (s: string) => ({ count: async () => s.includes('captcha') ? Number(challenge) : 1,
    isVisible: async () => true, isEditable: async () => true, fill: async () => { fills++ } }),
    evaluate: async () => { clicks++ } }
  const tap = { markPlatformRestriction: () => {}, refreshReplyEvidence: async () => {}, replyContext: () => ({ page, generation, facts,
    identityData: { synthetic_role: 'owner' }, loggedIn: true, roomId: 'room', roomObservedAt: Date.now() }) } as unknown as LiveTap
  const config = { expectedOwnerId: 'owner', expectedExecutorId: 'executor', inputSelector: 'textarea', submitSelector: 'button',
    creatorRoleEvidence: { path: ['synthetic_role'], value: 'owner' } }
  return { tap, config, clicks: () => clicks, fills: () => fills, change: () => { generation++ }, challenge: () => { challenge = true } }
}

test('buyin proof requires configured exact observed value, not a display name or truthy string', () => {
  assert.equal(matchesCreatorEvidence({ role: true }, undefined), false)
  assert.equal(matchesCreatorEvidence({ role: 'false' }, { path: ['role'], value: false }), false)
  assert.equal(matchesCreatorEvidence({}, { path: ['role'], value: false }), false)
  assert.equal(matchesCreatorEvidence(Object.create({ role: true }), { path: ['role'], value: true }), false)
})

test('captcha becomes a typed platform restriction and remains latched before any refresh', async () => {
  const f = fixture(); f.challenge()
  const driver = new BuyinReplyDriver(f.tap, f.config)
  await assert.rejects(driver.snapshot(), (e: any) => e.code === 'host_platform_restricted')
  await assert.rejects(driver.snapshot(), (e: any) => e.code === 'host_platform_restricted')
  assert.equal(f.clicks(), 0)
})

test('buyin driver refuses challenges and no click occurs on cancelled/rejected guard', async () => {
  for (const scenario of ['challenge', 'cancel', 'guard', 'navigation']) {
    const f = fixture(); const d = new BuyinReplyDriver(f.tap, f.config)
    const abort = new AbortController()
    if (scenario === 'challenge') f.challenge()
    if (scenario === 'cancel') abort.abort()
    await assert.rejects(d.submit('synthetic', async () => {
      if (scenario === 'guard') throw new Error('denied')
      if (scenario === 'navigation') f.change()
    }, abort.signal))
    assert.equal(f.clicks(), 0)
  }
})

test('buyin creator source refuses absent proof and halts after one unknown submission', async () => {
  const f = fixture(); const scope = { platform: 'douyin', accountId: 'owner', roomId: 'room', sessionId: 'session' }
  const missing = new BackgroundReplySource(new BuyinReplyDriver(f.tap, { ...f.config, creatorRoleEvidence: undefined }), () => scope,
    { ownerId: 'owner', executorId: 'executor', minIntervalMs: 5000, surface: 'buyin' })
  await assert.rejects(missing.withContext('buyin', ctx => ctx.read()), /permission_denied/)
  const source = new BackgroundReplySource(new BuyinReplyDriver(f.tap, f.config), () => scope,
    { ownerId: 'owner', executorId: 'executor', minIntervalMs: 5000, surface: 'buyin' })
  await source.withContext('buyin', async ctx => {
    const result = await ctx.execute({ ...scope, actionId: 'action', kind: 'reply', text: 'synthetic', userId: null, productId: null,
      deadlineAt: new Date(Date.now() + 5000).toISOString(), identityGuard: { surface: 'buyin', executorId: 'executor', identityRevision: 'synthetic', bindingRevision: 1 } })
    assert.equal(result.status, 'uncertain')
  })
  assert.equal(f.clicks(), 1)
  await assert.rejects(source.withContext('buyin', ctx => ctx.read()), /halted/)
});

test('buyin DOM path clicks once; disabled or replaced text never submits (intercepted synthetic page)', async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.TEST_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  try {
    const page = await browser.newPage()
    // Every request is fulfilled locally. No platform, login, comment or account is contacted.
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      '<textarea id="input"></textarea><button id="send">发送</button><script>window.sends=0;document.querySelector("#send").onclick=()=>window.sends++</script>' }))
    await page.goto('https://buyin.jinritemai.com/dashboard/live/control')
    const facts = { userId: 'owner', buyinAccountId: 'executor', observedAt: new Date().toISOString() }
    let restricted = false
    const tap = { markPlatformRestriction: () => { restricted = true }, refreshReplyEvidence: async () => {}, replyContext: () => ({ page, generation: 1, facts,
      identityData: { synthetic_role: 'owner' }, loggedIn: true, roomId: 'room', roomObservedAt: Date.now() }) } as unknown as LiveTap
    const driver = new BuyinReplyDriver(tap, { expectedOwnerId: 'owner', expectedExecutorId: 'executor',
      inputSelector: '#input', submitSelector: '#send', creatorRoleEvidence: { path: ['synthetic_role'], value: 'owner' } })
    assert.equal((await driver.submit('合成测试', async () => {})).status, 'uncertain')
    assert.equal(await page.evaluate('window.sends'), 1)
    await assert.rejects(driver.submit('合成测试', async () => { await page.locator('#input').fill('changed') }), /controls_changed/)
    await page.locator('#send').evaluate(el => el.setAttribute('disabled', ''))
    await assert.rejects(driver.submit('合成测试', async () => {}), /controls_changed/)
    assert.equal(await page.evaluate('window.sends'), 1)
    await page.locator('#send').evaluate(el => el.removeAttribute('disabled'))
    await assert.rejects(driver.submit('合成测试', async () => {
      await page.evaluate(() => { const challenge = document.createElement('div'); challenge.id = 'captcha'; challenge.style.width = '20px'; challenge.style.height = '20px'; document.body.append(challenge) })
    }), (e: any) => e.code === 'host_platform_restricted')
    assert.equal(restricted, true)
    assert.equal(await page.evaluate('window.sends'), 1)
  } finally { await browser.close() }
})
