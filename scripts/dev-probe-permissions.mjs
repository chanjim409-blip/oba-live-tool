/**
 * 只读：百应中控台上"这个登录身份到底能做什么"。
 *
 * 目的：回答"抖音直播间管理员那个角色在哪儿登录/授权"这种问题——不猜，直接看页面自己拿到的
 * 权限位（`/index/getUser` 的 dr_auth.*）和页面上是否真的存在评论输入区。
 * 权限位是 0/1 这类标志位，不是秘密；账号名/ID 一律掩码。
 *
 * 用法：node scripts/dev-probe-permissions.mjs --state <buyin.storage.json> [--seconds 25]
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

const mask = (value) => {
  const text = String(value ?? '')
  if (!text) return ''
  return text.length <= 3 ? text : `${text.slice(0, 2)}…${text.slice(-2)} (${text.length})`
}

let userInfo = null
page.on('response', async (response) => {
  if (!/\/index\/getUser/.test(response.url())) return
  try {
    const body = await response.json()
    const data = body?.data
    if (!data) return
    userInfo = {
      accountNameMasked: mask(data.name ?? data.nick_name ?? data.nickname ?? ''),
      user_id: mask(data.user_id),
      origin_uid: mask(data.origin_uid),
      buyin_account_id: mask(data.buyin_account_id),
      login_user_id: mask(data.login_user_id),
      // 权限位：0/1 之类的标志，属于"能不能做"，不是敏感内容
      dr_auth: data.dr_auth ?? null,
      roles: Array.isArray(data.roles) ? data.roles : undefined,
      accountTypeFields: Object.fromEntries(
        Object.entries(data)
          .filter(([key]) => /type|role|auth|permission|admin/i.test(key))
          .map(([key, value]) => [key, typeof value === 'object' ? '<object>' : value]),
      ),
    }
  } catch {
    /* 非 JSON */
  }
})

await page.goto('https://buyin.jinritemai.com/dashboard/live/control', { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(seconds * 1000)

const dom = await page
  .evaluate(() => {
    const texts = [...document.querySelectorAll('div,span,button,li,a')]
      .map((el) => el.textContent?.trim() ?? '')
      .filter((text) => text.length > 0 && text.length <= 6)
    const uniq = [...new Set(texts)]
    const interesting = ['互动', '评论', '弹幕', '讲解', '上架', '商品', '禁言', '置顶', '管理员', '中控台', '公开', '直播中', '未开播']
    return {
      hasTextarea: document.querySelectorAll('textarea').length,
      textareaSelectors: [...document.querySelectorAll('textarea')].map((el) => el.id || el.className || el.placeholder || '<no-id>').slice(0, 8),
      commentBlockPresent: Boolean(document.querySelector('#input-comment-block-id')),
      matchedKeywords: interesting.filter((word) => uniq.includes(word)),
      greetingPanel: Boolean(document.querySelector('[class*="comment"], [class*="Comment"], [class*="interact"]')),
    }
  })
  .catch((error) => ({ error: String(error) }))

console.log(JSON.stringify({ secondsWaited: seconds, userInfo, dom }, null, 2))
await browser.close()
