/**
 * 诊断：罗盘大屏通道到底通不通。
 * 用同一个 storageState 打开中控台拿到 room_id，再打开罗盘大屏，统计 60 秒内：
 *   · 所有 URL 含 message / live 的响应（含状态码与 content-type）
 *   · WebSocket 连接与帧数
 *   · 页面可见文本里的关键状态词（直播中/在线/暂无数据/已结束）
 * 只读。
 *
 * 用法：node scripts/dev-diag-compass.mjs --state <buyin.storage.json> [--seconds 60]
 */
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((item) => existsSync(item))
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback
}
const stateFile = arg('state', null)
if (!stateFile || !existsSync(stateFile)) throw new Error('需要 --state')
const seconds = Number(arg('seconds', 60))

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const consolePage = await context.newPage()

let roomId = null
consolePage.on('response', async (response) => {
  if (!/promotions_v2/.test(response.url())) return
  try {
    const body = await response.json()
    const value = body?.data?.room_id
    if (value && /^[0-9]{10,}$/.test(String(value))) roomId = String(value)
  } catch {}
})

await consolePage.goto('https://buyin.jinritemai.com/dashboard/live/control', { waitUntil: 'domcontentloaded', timeout: 60_000 })
for (let i = 0; i < 20 && !roomId; i += 1) await consolePage.waitForTimeout(1500)
if (!roomId) {
  console.log(JSON.stringify({ ok: false, error: 'console 没有给出当前 room_id' }))
  await browser.close()
  process.exit(0)
}
console.log(JSON.stringify({ step: 'room_id', length: roomId.length, masked: `${roomId.slice(0, 2)}…${roomId.slice(-2)}` }))

const compass = await context.newPage()
const responses = []
const sockets = []
compass.on('response', (response) => {
  const url = response.url()
  if (!/jinritemai\.com/.test(url)) return
  if (!/message|live|screen|room/i.test(url)) return
  responses.push({ host: new URL(url).host, path: new URL(url).pathname, status: response.status(), type: (response.headers()['content-type'] ?? '').slice(0, 30) })
})
compass.on('websocket', (socket) => {
  const entry = { url: socket.url().replace(/\?.*$/, ''), framesIn: 0 }
  sockets.push(entry)
  socket.on('framereceived', () => {
    entry.framesIn += 1
  })
})

await compass.goto('https://compass.jinritemai.com/talent', { waitUntil: 'domcontentloaded', timeout: 45_000 })
const compassLogin = await compass
  .waitForSelector('div[class^="userName"]', { timeout: 20_000 })
  .then(() => true)
  .catch(() => false)
await compass.goto(`https://compass.jinritemai.com/screen/anchor/talent?live_room_id=${roomId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
await compass.waitForTimeout(seconds * 1000)

const text = await compass.evaluate(() => (document.body?.innerText ?? '').slice(0, 4000)).catch(() => '')
const words = ['直播中', '在线', '观看', '暂无数据', '已结束', '未开播', '异常', '无权限']
console.log(
  JSON.stringify(
    {
      compassLoginDetected: compassLogin,
      finalUrl: compass.url(),
      title: await compass.title().catch(() => null),
      visibleWords: words.filter((word) => text.includes(word)),
      textSample: text.replace(/\s+/g, ' ').slice(0, 300),
      responseCount: responses.length,
      responses: responses.slice(0, 25),
      sockets,
    },
    null,
    2,
  ),
)
await browser.close()
