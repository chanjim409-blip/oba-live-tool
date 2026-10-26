/**
 * 只读：在百应后台里找「子账号 / 账号管理 / 权限」这类入口的真实路径。
 * 只读菜单与链接文本（不点按钮、不改配置），把 href 原样报出来。
 *
 * 用法：node scripts/dev-probe-subaccount-page.mjs --state <主账号 storageState>
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

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const page = await context.newPage()

const menuPages = []
page.on('response', async (response) => {
  const url = response.url()
  if (!/jinritemai\.com/.test(url)) return
  if (!/json/i.test(response.headers()['content-type'] ?? '')) return
  if (!/permission|menu|account|role/i.test(url)) return
  try {
    const body = await response.json()
    const data = body?.data ?? body
    const lists = []
    for (const [key, value] of Object.entries(data ?? {})) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
        lists.push({ key, sample: value.slice(0, 40).map((item) => ({ name: item.name ?? item.title ?? '', url: item.url ?? item.path ?? '' })) })
      }
    }
    if (lists.length) menuPages.push({ path: new URL(url).pathname, lists })
  } catch {}
})

await page.goto('https://buyin.jinritemai.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(12_000)

const keywords = ['子账号', '账号管理', '成员', '团队', '权限', '授权', '设置', '角色']
const found = await page
  .evaluate((words) => {
    const hits = []
    const seen = new Set()
    for (const el of document.querySelectorAll('a, button, li, div[role="menuitem"], span')) {
      const text = (el.textContent ?? '').trim()
      if (!text || text.length > 20) continue
      if (!words.some((word) => text.includes(word))) continue
      const href = el.getAttribute?.('href') ?? el.closest('a')?.getAttribute('href') ?? ''
      const key = `${text}|${href}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ text, href })
      if (hits.length > 40) break
    }
    return hits
  }, keywords)
  .catch(() => [])

console.log(
  JSON.stringify(
    {
      url: page.url(),
      title: await page.title().catch(() => null),
      keywordHits: found,
      menuResponses: menuPages.slice(0, 6),
    },
    null,
    2,
  ),
)
await browser.close()
