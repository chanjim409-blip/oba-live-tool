/**
 * 只读：用真实浏览器打开公开直播间页，看能不能拿到可拉流的地址（不解码、不保存媒体）。
 * 目的只有一个：确认"匿名浏览器能否拿到本场 flv/hls 地址"，为 ASR 取音找一条可复现的路。
 *
 * 用法：node scripts/dev-probe-stream.mjs --room <公开web短号> [--headed]
 */
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((item) => existsSync(item))
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback
}
const room = String(arg('room', ''))
if (!/^\d{1,30}$/.test(room)) throw new Error('需要 --room 提供公开 web 短号；不能用历史内部 room_id 替代')
const headed = process.argv.includes('--headed')

const browser = await chromium.launch({ headless: !headed, executablePath: CHROME || undefined })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, userAgent: undefined })
const page = await context.newPage()

const found = []
const note = (source, value) => {
  for (const item of value) {
    if (found.some((x) => x.url === item.url)) continue
    found.push({ source, ...item })
  }
}
const pickPull = (json) => {
  const out = []
  const walk = (node, depth = 0) => {
    if (!node || depth > 8) return
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1))
    if (typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (/^(flv_pull_url|hls_pull_url|flv_pull_url_|rtmp_pull_url|stream_url)$/i.test(key)) {
        if (typeof value === 'string' && /^https?:/.test(value)) out.push(value)
        else if (value && typeof value === 'object') {
          for (const inner of Object.values(value)) if (typeof inner === 'string' && /^https?:/.test(inner)) out.push(inner)
        }
      } else if (/pull_data|stream_data|stream_url/i.test(key) && typeof value === 'object') {
        walk(value, depth + 1)
      } else walk(value, depth + 1)
    }
  }
  walk(json)
  return [...new Set(out)].map((url) => ({ url, kind: /\.flv|\/g\.flv/i.test(url) ? 'flv' : /m3u8/i.test(url) ? 'hls' : 'other' }))
}

page.on('response', async (response) => {
  const url = response.url()
  if (!/webcast|douyin\.com/.test(url)) return
  const type = response.headers()['content-type'] ?? ''
  if (!/json/i.test(type)) return
  try {
    const body = await response.json()
    const pulls = pickPull(body)
    if (pulls.length) note(new URL(url).pathname, pulls)
    const roomId = typeof body?.data?.data?.[0]?.id_str === 'string' ? body.data.data[0].id_str : null
    if (roomId) note(`room-resolve:${new URL(url).pathname}`, [{ url: `room_id=${roomId}`, kind: 'room' }])
  } catch {}
})

await page.goto(`https://live.douyin.com/${room}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(20_000)
const title = await page.title().catch(() => null)
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => null)
const playerState = await page.evaluate(() => {
  const video = document.querySelector('video')
  return {
    hasVideo: Boolean(video),
    src: video?.getAttribute('src')?.slice(0, 120) ?? null,
    readyState: video?.readyState ?? null,
    duration: video?.duration ?? null,
    playing: video ? !video.paused : null,
  }
}).catch(() => null)

console.log(JSON.stringify({
  room,
  pageUrl: page.url(),
  title,
  bodyText,
  playerState,
  pulls: found.map((item) => ({ source: item.source, kind: item.kind, urlHint: item.url.replace(/\?.*$/, ''), queryLen: (item.url.split('?')[1] ?? '').length })),
  count: found.length,
}, null, 2))
await browser.close()
