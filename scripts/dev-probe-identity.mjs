/**
 * 只读探查一个百应登录身份：它是谁、能进哪些页面、页面上真实存在哪些操作入口。
 *
 * 目的：决定它能不能扮演业务模型里的某个 surface。**只看页面上真实存在的入口**
 * （评论输入框 / 讲解按钮 / 禁言等），不从"角色名"或配置推导权限。
 *
 * 用法：node scripts/dev-probe-identity.mjs --state <storageState 文件> [--seconds 25]
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
const seconds = Number(arg('seconds', 25))

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const page = await context.newPage()

let user = null
let menu = null
page.on('response', async (response) => {
  const url = response.url()
  if (!/jinritemai\.com/.test(url)) return
  if (!/json/i.test(response.headers()['content-type'] ?? '')) return
  try {
    if (/\/index\/getUser/.test(url)) {
      const body = await response.json()
      const data = body?.data ?? {}
      user = {
        // 只报长度与字段名：真实 ID 值不进日志
        userIdLen: data.user_id ? String(data.user_id).length : 0,
        originUidLen: data.origin_uid ? String(data.origin_uid).length : 0,
        loginUserIdLen: data.login_user_id ? String(data.login_user_id).length : 0,
        buyinAccountIdLen: data.buyin_account_id ? String(data.buyin_account_id).length : 0,
        accountChildType: data.account_child_type ?? null,
        shopTypeChild: data.shop_type_child ?? null,
        userRole: data.user_role ?? null,
        userIdentityType: data.user_identity_type ?? null,
        drAuth: data.dr_auth ?? null,
        nicknameLen: String(data.nickname ?? data.name ?? '').length,
      }
    } else if (/\/api\/permission\/menu/.test(url)) {
      const body = await response.json()
      const data = body?.data ?? {}
      menu = {
        menus: (data.menu_list ?? []).map((item) => item.name),
        pages: (data.page_list ?? []).map((item) => `${item.name}${item.url ? ' ' + item.url : ''}`),
      }
    }
  } catch {}
})

await page.goto('https://buyin.jinritemai.com/dashboard/live/control', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(seconds * 1000)

const affordances = await page
  .evaluate(() => {
    const text = document.body?.innerText ?? ''
    const keywords = ['回复观众', '直接发评', '讲解', '取消讲解', '禁言', '拉黑', '黑名单', '置顶', '评论', '互动', '直播中', '未开播', '商品讲解']
    return {
      keywords: keywords.filter((word) => text.includes(word)),
      textareas: [...document.querySelectorAll('textarea')].map((el) => ({ placeholder: (el.placeholder ?? '').slice(0, 40), cls: String(el.className).slice(0, 30) })),
      commentBlock: Boolean(document.querySelector('#input-comment-block-id')),
      goodsPanel: Boolean(document.querySelector('[class^="goodsPanel"]')),
      buttonsWith讲解: [...document.querySelectorAll('button')].map((el) => el.textContent?.trim() ?? '').filter((value) => value.includes('讲解')).slice(0, 5),
      url: location.href,
      title: document.title,
    }
  })
  .catch((error) => ({ error: String(error) }))

console.log(JSON.stringify({ stateFile, user, menu, affordances }, null, 2))
await browser.close()
