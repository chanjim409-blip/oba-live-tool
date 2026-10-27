import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { RoomBrowserDriver } from './roomBrowserDriver'

test('manual handoff closes the owned context first, blocks sends/refresh, and stays blocked on failed recheck', async () => {
  const driver = new RoomBrowserDriver({ profileDir: 'synthetic', executablePath: '', capturePaths: [],
    anchorName: 'synthetic', expectedOwnerId: 'owner', expectedExecutorId: 'assistant' })
  const sequence: string[] = []
  const page = { goto: async () => { sequence.push('navigate') }, bringToFront: async () => {}, isClosed: () => false }
  Object.assign(driver, { context: { close: async () => { sequence.push('close') } },
    launchOwnedContext: async (headless: boolean) => {
      sequence.push(headless ? 'headless' : 'visible')
      Object.assign(driver, { selfPage: page, roomPage: page, context: { close: async () => { sequence.push('close') } } })
    } })
  await driver.beginManualVerification()
  assert.deepEqual(sequence.slice(0, 2), ['close', 'visible'])
  assert.equal((await driver.inspect()).manualState, 'manual')
  await assert.rejects(() => driver.snapshot(), /manual_verification_active/)
  await assert.rejects(() => driver.refresh(), /manual_verification_active/)
  let submits = 0
  await assert.rejects(() => driver.submit('synthetic', async () => { submits++ }), /manual_verification_active/)
  assert.equal(submits, 0)
  await assert.rejects(() => driver.completeManualVerification()) // no new platform evidence in this fake
  assert.equal((await driver.inspect()).manualState, 'blocked')
  assert.equal((await driver.inspect()).restricted, false, 'local recheck failure must not fabricate platform restriction')
  assert.equal((await driver.inspect()).manualFailure, 'bridge_manual_recheck_failed')
  await assert.rejects(() => driver.snapshot(), /manual_verification_active/)
})

test('manual completion returns to background only after fresh identity checks and never submits', async () => {
  const driver = new RoomBrowserDriver({ profileDir: 'synthetic', executablePath: '', capturePaths: [],
    anchorName: 'synthetic', expectedOwnerId: 'owner', expectedExecutorId: 'assistant' })
  let checked = false
  Object.assign(driver, { manualState: 'manual', manualWindowVisible: true,
    context: { close: async () => {} }, launchOwnedContext: async () => {}, refresh: async () => {},
    snapshot: async () => { checked = true; return { blocked: false, live: true, admin: true, canSend: true, ownerId: 'owner', executorId: 'assistant' } } })
  await driver.completeManualVerification()
  assert.equal(checked, true)
  const info = await driver.inspect()
  assert.equal(info.manualState, 'none')
  assert.equal(info.desktopVisible, false)
  await assert.rejects(() => driver.completeManualVerification(), /manual_not_open/)
})

test('missing composer is a local block, not a platform restriction', async () => {
  const driver = new RoomBrowserDriver({ profileDir: 'synthetic', executablePath: '', capturePaths: [],
    anchorName: 'synthetic', expectedOwnerId: 'owner', expectedExecutorId: 'assistant' })
  Object.assign(driver, { manualState: 'manual', context: { close: async () => {} },
    launchOwnedContext: async () => {}, refresh: async () => {},
    snapshot: async () => ({ blocked: false, live: true, admin: true, canSend: false, ownerId: 'owner', executorId: 'assistant' }) })
  await assert.rejects(() => driver.completeManualVerification(), /controls_unavailable/)
  const info = await driver.inspect()
  assert.equal(info.manualState, 'blocked')
  assert.equal(info.manualFailure, 'bridge_manual_controls_unavailable')
  assert.equal(info.restricted, false)
  assert.equal(driver.manualVerificationActive, true)
})

test('control diagnostics return counts/booleans only and do not refresh the page', async () => {
  const driver = new RoomBrowserDriver({ profileDir: 'synthetic', executablePath: '', capturePaths: [],
    anchorName: 'synthetic', expectedOwnerId: 'owner', expectedExecutorId: 'assistant', inputSelector: '#input', submitSelector: '#send' })
  Object.assign(driver, { roomPage: { isClosed: () => false, locator: (selector: string) => ({
    count: async () => selector === '#input' || selector === '#send' ? 1 : 0,
    isVisible: async () => true, isEditable: async () => true,
  }) } })
  assert.deepEqual(await driver.diagnoseControls(), { available: true, challengeCount: 0, inputCount: 1, submitCount: 1,
    inputVisible: true, inputEditable: true, submitVisible: true })
})

test('preflight stays readable when renderer evaluation never resolves', async () => {
  const driver = new RoomBrowserDriver({ profileDir: 'synthetic', executablePath: '', capturePaths: [],
    anchorName: 'synthetic', expectedOwnerId: 'owner', expectedExecutorId: 'assistant' })
  let evaluations = 0
  Object.assign(driver, { roomPage: { evaluate: () => { evaluations++; return new Promise(() => {}) } } })
  const info = await driver.inspect()
  assert.equal(evaluations, 0)
  assert.equal(info.loggedIn, false)
  assert.equal(info.controls, null)
})

test('failed refresh clears cached identities and advances both generations', async () => {
  const driver = new RoomBrowserDriver({ profileDir: 'synthetic', executablePath: '', capturePaths: [],
    anchorName: 'synthetic', expectedOwnerId: 'owner', expectedExecutorId: 'assistant' })
  const page = { isClosed: () => false, waitForResponse: async () => { throw new Error('timeout') }, goto: async () => {} }
  Object.assign(driver, { selfPage: page, roomPage: page, self: { id: 'assistant', at: Date.now() },
    room: { at: Date.now(), value: { ownerId: 'owner', roomId: 'synthetic', live: true, adminIds: ['assistant'] } } })
  await assert.rejects(() => driver.refresh(), /bridge_reply_self_response_unavailable/)
  const info = await driver.inspect()
  assert.equal(info.loggedIn, false)
  assert.equal(info.ownerMatches, false)
  assert.equal(info.observedAt, null)
  assert.equal(info.refreshFailure, 'bridge_reply_self_response_unavailable')
  assert.deepEqual((driver as unknown as { generations: unknown }).generations, { self: 1, room: 1 })
})

test('real DOM SVG submission fires once, and changed text/disabled control fail before clicking', async () => {
  const server = createServer((_request, response) => response.end(`<div id="input" contenteditable="true"></div><svg id="send" width="40" height="40" type="button"></svg><script>window.sends=0;document.querySelector('#send').addEventListener('click',()=>window.sends++)</script>`))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.TEST_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  try {
    const page = await browser.newPage()
    await page.goto(url)
    const driver = new RoomBrowserDriver({ profileDir: 'synthetic', executablePath: '', capturePaths: [],
      anchorName: 'synthetic', expectedOwnerId: 'synthetic', expectedExecutorId: 'synthetic', inputSelector: '#input', submitSelector: '#send' })
    Object.assign(driver, { roomPage: page, url })
    let checks = 0
    const result = await driver.submit('synthetic test', async () => { checks++ })
    assert.equal(result.status, 'uncertain')
    assert.equal(checks, 1)
    assert.equal(await page.evaluate('window.sends'), 1)
    await assert.rejects(() => driver.submit('synthetic test', async () => { await page.locator('#input').fill('changed') }), /submit_unavailable/)
    await page.locator('#send').evaluate(node => node.setAttribute('disabled', ''))
    await assert.rejects(() => driver.submit('synthetic test', async () => {}), /submit_unavailable/)
    assert.equal(await page.evaluate('window.sends'), 1)
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
