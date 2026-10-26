/**
 * 只读：确认中控台页面自己发的接口里到底有没有弹幕/礼物/进入房间这类事件，
 * 以及它们的字段结构（只打**键名**和条数，不打值，不打昵称与内容）。
 *
 * 用法：node scripts/dev-probe-messages.mjs --state <buyin.storage.json> [--seconds 20]
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
const seconds = Number(arg('seconds', 20))
const home = 'https://buyin.jinritemai.com/dashboard/live/control'

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const page = await context.newPage()

const observed = new Map()
page.on('response', async (response) => {
  const url = response.url()
  if (!/jinritemai\.com\/(api|connection)\//.test(url)) return
  const contentType = response.headers()['content-type'] ?? ''
  if (!/json/i.test(contentType)) return
  try {
    const body = await response.json()
    const path = new URL(url).pathname
    const data = body?.data ?? body
    // 只关心"像消息列表"的结构
    const listKeys = []
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
          listKeys.push({ key, count: value.length, itemKeys: Object.keys(value[0]).slice(0, 14) })
        }
      }
    }
    if (listKeys.length === 0) return
    const previous = observed.get(path) ?? { hits: 0, listKeys: new Map() }
    previous.hits += 1
    for (const item of listKeys) {
      const known = previous.listKeys.get(item.key) ?? { max: 0, itemKeys: item.itemKeys }
      known.max = Math.max(known.max, item.count)
      previous.listKeys.set(item.key, known)
    }
    observed.set(path, previous)
  } catch {
    /* 非 JSON */
  }
})

await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(seconds * 1000)

const report = {
  secondsWaited: seconds,
  endpoints: [...observed.entries()].map(([path, info]) => ({
    path,
    responses: info.hits,
    lists: [...info.listKeys.entries()].map(([key, detail]) => ({ key, maxItems: detail.max, itemKeys: detail.itemKeys })),
  })),
}
console.log(JSON.stringify(report, null, 2))
await browser.close()
