/**
 * 只读：看中控台页面自己有没有 WebSocket（弹幕/互动通常是 WS 推送，不是 HTTP 轮询）。
 * 只报 WS 的域名与帧数量、帧的形态（JSON/二进制/长度），不解析内容、不打明文。
 *
 * 用法：node scripts/dev-probe-ws.mjs --state <buyin.storage.json> [--seconds 25]
 */
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((item) => existsSync(item))

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback
}
const stateFile = arg('state', null)
if (!stateFile || !existsSync(stateFile)) throw new Error('需要 --state')
const seconds = Number(arg('seconds', 25))

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const page = await context.newPage()

const sockets = []
page.on('websocket', (socket) => {
  const entry = { url: socket.url().replace(/\?.*$/, '?…'), framesIn: 0, framesOut: 0, shapes: new Set() }
  sockets.push(entry)
  socket.on('framereceived', (frame) => {
    entry.framesIn += 1
    const payload = frame.payload
    if (typeof payload === 'string') {
      entry.shapes.add(payload.startsWith('{') || payload.startsWith('[') ? `json:${payload.length}` : `text:${payload.length}`)
    } else {
      entry.shapes.add(`binary:${payload?.length ?? '?'}`)
    }
  })
  socket.on('framesent', () => {
    entry.framesOut += 1
  })
})

await page.goto('https://buyin.jinritemai.com/dashboard/live/control', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(seconds * 1000)

const tabs = await page
  .evaluate(() =>
    [...document.querySelectorAll('div[class*="tab"], [role="tab"], li[class*="menu"]')]
      .map((el) => el.textContent?.trim() ?? '')
      .filter((text) => text.length > 0 && text.length <= 8)
      .slice(0, 20),
  )
  .catch(() => [])

console.log(
  JSON.stringify(
    {
      secondsWaited: seconds,
      webSockets: sockets.map((item) => ({ url: item.url, framesIn: item.framesIn, framesOut: item.framesOut, shapes: [...item.shapes].slice(0, 6) })),
      visibleTabLabels: tabs,
      liveWords: await page
        .evaluate(() => ['直播中', '未开播', '直播已结束'].filter((word) => (document.body?.innerText ?? '').includes(word)))
        .catch(() => []),
    },
    null,
    2,
  ),
)
await browser.close()
