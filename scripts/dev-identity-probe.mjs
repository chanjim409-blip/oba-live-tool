/**
 * 只读核验 + 证据勘察：用某个 storageState（本机私有目录里的登录态）打开目标页面，
 * 回答两件事：(1) 到底登录没登录、中控台是否就绪；(2) **稳定标识/房间号能从哪儿读出来**。
 *
 * 只做只读观察：不点任何业务按钮、不发送任何内容、不滚动触发懒加载之外的交互。
 * 真实 ID 一律只打掩码与长度，不进日志。
 *
 * 用法：
 *   node scripts/dev-identity-probe.mjs --site buyin  --state <buyin.storage.json>
 *   node scripts/dev-identity-probe.mjs --site douyin --state <douyin.storage.json>
 *   node scripts/dev-identity-probe.mjs --site buyin --state <...> --deep   # 额外记录接口候选
 */
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const SITES = {
  douyin: {
    label: '抖音小店·中控台',
    home: 'https://fxg.jinritemai.com/ffa/buyin/dashboard/live/control',
    accountName: '[class^="index_userName"]',
    inLive: '[class^="goodsPanel"]',
    commentInput: '#input-comment-block-id textarea',
  },
  buyin: {
    label: '巨量百应·中控台',
    home: 'https://buyin.jinritemai.com/dashboard/live/control',
    accountName: 'span.btn-item-role-exchange-name__title',
    inLive: '[class^="goodsPanel"]',
    commentInput: '#input-comment-block-id textarea',
  },
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((item) => existsSync(item))

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback
}

const siteKey = String(arg('site', 'buyin'))
const site = SITES[siteKey]
if (!site) throw new Error(`不认识的站点：${siteKey}`)
const stateFile = arg('state', null)
if (!stateFile || !existsSync(stateFile)) throw new Error('需要 --state 指向 storageState 文件')
const deep = Boolean(arg('deep', false))
const waitMs = Number(arg('wait', 12000))

const mask = (value) => {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text.length <= 4) return `${text.length} chars`
  return `${text.slice(0, 2)}…${text.slice(-2)} (${text.length} chars)`
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const page = await context.newPage()

/** 深挖模式：记录页面自己发的请求，以及响应里"像 ID 的字段名"。只看键名，不看值。 */
const apiCandidates = []
if (deep) {
  page.on('response', async (response) => {
    const url = response.url()
    if (!/jinritemai\.com/.test(url)) return
    if (!/live|room|dashboard|talent|shop|account|user/i.test(url)) return
    if (!/json/i.test(response.headers()['content-type'] ?? '')) return
    try {
      const body = await response.json()
      const keys = new Set()
      const walk = (node, path, depth) => {
        if (!node || typeof node !== 'object' || depth > 3) return
        for (const [key, value] of Object.entries(node)) {
          if (/id|room|room_id|uid|user_id|author/i.test(key) && (typeof value === 'string' || typeof value === 'number')) {
            keys.add(`${path}${key}=${mask(value)}`)
          } else if (typeof value === 'object') {
            walk(value, `${path}${key}.`, depth + 1)
          }
        }
      }
      walk(body, '', 0)
      if (keys.size) {
        apiCandidates.push({ path: new URL(url).pathname, keys: [...keys].slice(0, 12) })
      }
    } catch {
      /* 不是 JSON 就跳过 */
    }
  })
}

const result = { site: siteKey, label: site.label, stateFile, deep, checks: {}, apiCandidates: [] }
try {
  const response = await page.goto(site.home, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  result.httpStatus = response?.status() ?? null
  result.finalUrl = page.url()
  result.title = await page.title()
  await page.waitForTimeout(waitMs)

  result.checks = await page.evaluate(
    ({ accountName, inLive, commentInput }) => {
      const text = document.body?.innerText ?? ''
      const maskOf = (value) => {
        const t = String(value ?? '').trim()
        if (!t) return ''
        return t.length <= 4 ? `${t.length} chars` : `${t.slice(0, 2)}…${t.slice(-2)} (${t.length} chars)`
      }
      // 页面上"像房间号/达人号"的东西：只报出现位置与长度，不报明文
      const longNumbers = []
      for (const el of document.querySelectorAll('a[href], [data-room-id], [data-live-room-id]')) {
        const href = el.getAttribute?.('href') ?? ''
        const match = /(?:live_room_id|room_id|roomId)[=/](\d{6,})/i.exec(href)
        if (match) longNumbers.push({ where: 'href', pattern: match[0].split('=')[0], value: maskOf(match[1]) })
      }
      return {
        onLoginPage: /\/login|passport/.test(location.href),
        accountNamePresent: Boolean(document.querySelector(accountName)),
        accountNameMasked: maskOf(document.querySelector(accountName)?.textContent),
        livePanelPresent: Boolean(document.querySelector(inLive)),
        commentInputPresent: Boolean(document.querySelector(commentInput)),
        // 开播状态：只有中控台页面才会有这两个词之一
        liveStateWord: ['直播中', '未开播', '直播已结束', '休息中'].find((word) => text.includes(word)) ?? null,
        // 评论/互动区域是否存在（未开播时通常没有输入框）
        hasCommentListWrapper: Boolean(document.querySelector('#comment-list-wrapper')),
        hasGoodsListContainer: Boolean(document.querySelector('#live-control-goods-list-container')),
        roomIdHints: longNumbers.slice(0, 10),
        // 页面自带的全局对象里有没有可读的状态（只报键名）
        globalCandidates: Object.keys(window).filter((key) => /__|INITIAL|PRELOAD|APP|STORE/i.test(key)).slice(0, 15),
        textLength: text.length,
      }
    },
    { accountName: site.accountName, inLive: site.inLive, commentInput: site.commentInput },
  )
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
} finally {
  if (deep) await page.waitForTimeout(1500)
  result.apiCandidates = apiCandidates
  await browser.close()
}

console.log(JSON.stringify(result, null, 2))
