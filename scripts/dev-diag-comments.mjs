/**
 * 紧急定位：找中控台上"哪一块是弹幕区"，以及消息到底从哪个通道进来。
 * 只读：不点击、不输入；只观察 DOM 与响应形状（键名/条数/长度，不打明文）。
 *
 * 用法：node scripts/dev-diag-comments.mjs --state <file> [--seconds 40]
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
const seconds = Number(arg('seconds', 40))

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const page = await context.newPage()

const apiShapes = new Map()
const sockets = []
page.on('response', async (response) => {
  const url = response.url()
  if (!/jinritemai\.com/.test(url)) return
  if (!/json/i.test(response.headers()['content-type'] ?? '')) return
  if (!/message|comment|im\/|interact|chat/i.test(url)) return
  try {
    const body = await response.json()
    const path = new URL(url).pathname
    const data = body?.data ?? body
    const shape = { count: (apiShapes.get(path)?.count ?? 0) + 1, keys: [], listKeys: [] }
    if (data && typeof data === 'object') {
      shape.keys = Object.keys(data).slice(0, 20)
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
          shape.listKeys.push({ key, items: value.length, itemKeys: Object.keys(value[0]).slice(0, 16) })
        }
      }
    }
    if (shape.listKeys.length || !apiShapes.has(path)) apiShapes.set(path, shape)
    else apiShapes.get(path).count += 1
  } catch {}
})
page.on('websocket', (socket) => {
  const entry = { url: socket.url().replace(/\?.*$/, ''), framesIn: 0, shapes: new Set() }
  sockets.push(entry)
  socket.on('framereceived', (frame) => {
    entry.framesIn += 1
    entry.shapes.add(typeof frame.payload === 'string' ? `text:${frame.payload.length}` : `bin:${frame.payload?.length ?? '?'}`)
  })
})

await page.goto('https://buyin.jinritemai.com/dashboard/live/control', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(12_000)

/** 两次采样，找出"子节点数量在变化"的容器 = 正在滚动的消息列表 */
const sample = () =>
  page.evaluate(() => {
    const out = []
    const walk = (node, path, depth) => {
      if (depth > 12 || !node || node.nodeType !== 1) return
      const children = node.children?.length ?? 0
      if (children >= 2) {
        const tag = node.tagName.toLowerCase()
        const cls = typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
        const id = node.id ? `#${node.id}` : ''
        const signature = `${tag}${id}${cls}`
        if (signature.length <= 80) out.push({ signature, children, textLen: (node.textContent ?? '').length })
      }
      for (const child of Array.from(node.children ?? [])) walk(child, `${path}>${node.tagName}`, depth + 1)
    }
    walk(document.body, '', 0)
    return out
  })

const first = await sample()
await page.waitForTimeout(Math.max(8, seconds - 12) * 1000)
const second = await sample()

const firstMap = new Map(first.map((item) => [item.signature, item]))
const changed = []
for (const item of second) {
  const previous = firstMap.get(item.signature)
  if (!previous) continue
  const delta = item.children - previous.children
  if (delta !== 0 || item.textLen !== previous.textLen) changed.push({ signature: item.signature, children: item.children, deltaChildren: delta, textLen: item.textLen })
}
changed.sort((a, b) => Math.abs(b.deltaChildren) - Math.abs(a.deltaChildren))

console.log(
  JSON.stringify(
    {
      apiShapes: [...apiShapes.entries()].map(([path, shape]) => ({ path, ...shape })),
      sockets: sockets.map((socket) => ({ url: socket.url, framesIn: socket.framesIn, shapes: [...socket.shapes].slice(0, 4) })),
      changedContainers: changed.slice(0, 12),
      topLevelTextareas: await page.evaluate(() => [...document.querySelectorAll('textarea')].map((el) => ({ id: el.id, cls: String(el.className).slice(0, 40), ph: el.placeholder ?? '' }))).catch(() => []),
    },
    null,
    2,
  ),
)
await browser.close()
