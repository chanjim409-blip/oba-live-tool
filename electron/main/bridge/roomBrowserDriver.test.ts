import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { RoomBrowserDriver } from './roomBrowserDriver'

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
