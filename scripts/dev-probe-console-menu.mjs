/**
 * 只读：百应这套登录身份到底"能看到/被授权"哪些功能（菜单与页面清单），
 * 以及页面上是否出现 禁言/拉黑/互动/评论区 这类管理入口。
 *
 * 依据：中控台自己会调 `/api/permission/menu`（返回 menu_list + page_list，就是该账号被授权的功能集）。
 * 只报菜单**名称与路径**（这是功能名，不是业务数据），不点任何按钮、不发送。
 *
 * 用法：node scripts/dev-probe-console-menu.mjs --state <buyin.storage.json> [--seconds 25]
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

let menu = null
let permissionTips = null
page.on('response', async (response) => {
  const url = response.url()
  if (!/jinritemai\.com/.test(url)) return
  if (!/json/i.test(response.headers()['content-type'] ?? '')) return
  try {
    if (/\/api\/permission\/menu/.test(url)) {
      const body = await response.json()
      const data = body?.data ?? {}
      const slim = (list) =>
        Array.isArray(list)
          ? list.slice(0, 40).map((item) => ({
              name: item.name ?? item.title ?? '',
              url: item.url ?? '',
              children: Array.isArray(item.children) ? item.children.map((child) => child.name ?? child.title ?? '') : undefined,
            }))
          : []
      menu = { menuList: slim(data.menu_list), pageList: slim(data.page_list) }
    } else if (/permission\/tips/.test(url)) {
      const body = await response.json()
      permissionTips = body?.data ?? body ?? null
    }
  } catch {
    /* 非 JSON */
  }
})

await page.goto('https://buyin.jinritemai.com/dashboard/live/control', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(seconds * 1000)

const keywords = ['禁言', '拉黑', '解禁', '黑名单', '互动', '评论区', '管理员', '权限', '发言', '评论', '置顶', '踢']
const domHits = await page
  .evaluate((words) => {
    const text = document.body?.innerText ?? ''
    return words.filter((word) => text.includes(word))
  }, keywords)
  .catch(() => [])

const menuNames = []
if (menu) {
  for (const item of menu.menuList) {
    menuNames.push(item.name)
    for (const child of item.children ?? []) menuNames.push(`${item.name}/${child}`)
  }
  for (const item of menu.pageList) menuNames.push(`页面:${item.name}`)
}
const menuHits = keywords.filter((word) => menuNames.some((name) => name.includes(word)))

console.log(
  JSON.stringify(
    {
      secondsWaited: seconds,
      // 页面文本里出现的功能词（说明界面上真有这个入口）
      domKeywordsPresent: domHits,
      // 权限接口给出的菜单里出现的功能词（说明这个身份被授权了这些功能）
      menuKeywordsPresent: menuHits,
      menu,
      permissionTipsPresent: Boolean(permissionTips),
      textareas: await page.evaluate(() => document.querySelectorAll('textarea').length).catch(() => null),
      commentBlockPresent: await page.evaluate(() => Boolean(document.querySelector('#input-comment-block-id'))).catch(() => null),
      commentListPresent: await page.evaluate(() => Boolean(document.querySelector('#comment-list-wrapper'))).catch(() => null),
    },
    null,
    2,
  ),
)
await browser.close()
