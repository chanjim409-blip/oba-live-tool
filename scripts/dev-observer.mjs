/**
 * 只读观察器：等开播 → 采集 N 分钟真实数据 → 出指标报告。
 *
 * 数据来源全部是**页面自己发出的请求的响应**（我们只读，不额外请求、不点击业务按钮、不输入、不发送）：
 *   1. 中控台（buyin.jinritemai.com/dashboard/live/control）
 *      · `promotions_v2?`  → `data.room_id`（直播间号）、货盘（product_id / promotion_id / stock_num / status）
 *      · `comment/info?`   → `comment_infos[]`（comment_id / nick_name / content）——中控台自己的弹幕轮询
 *   2. 电商罗盘大屏（compass.jinritemai.com/screen/anchor/talent?live_room_id=…）
 *      · `message?`        → `data.messages.{comment,room_enter,room_like,room_follow,ecom_fansclub_participate,…}`
 *      · `live_order_stream?` → 订单事件
 * 这两条通道是上游宿主已经验证过的（electron/main/platforms/douyin/commentListener.ts）。
 *
 * 用法（宿主仓根目录）：
 *   node scripts/dev-observer.mjs --state <buyin.storage.json> --minutes 15 --wait-minutes 360 --label 赖啤G
 *
 * 产物（全部在本机私有目录，不进 Git）：
 *   <out>/events.jsonl   原始事件（含昵称与文本，属于真实业务数据）
 *   <out>/report.json    汇总指标
 *   <out>/report.md      给人看的报告
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

const systemPrivateRoot = resolve(process.env.LIVE_ASSISTANT_PRIVATE_DIR || (process.platform === 'win32' ? 'D:/live-assistant/private' : join(process.env.HOME || '.', 'live-assistant-private')))
const stateFile = arg('state', null)
if (!stateFile || !existsSync(stateFile)) throw new Error('需要 --state 指向 storageState 文件')
const minutes = Number(arg('minutes', 15))
const waitMinutes = Number(arg('wait-minutes', 360))
const pollSeconds = Number(arg('poll', 20))
const label = String(arg('label', 'unknown-anchor'))
const outDir = resolve(arg('out', join(systemPrivateRoot, 'observe', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))))
mkdirSync(outDir, { recursive: true })

const CONSOLE_URL = 'https://buyin.jinritemai.com/dashboard/live/control'
const COMPASS_INDEX = 'https://compass.jinritemai.com/talent'
const COMPASS_SCREEN = 'https://compass.jinritemai.com/screen/anchor/talent?live_room_id='

const eventsFile = join(outDir, 'events.jsonl')
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)
const mask = (value) => {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.length <= 3 ? text : `${text.slice(0, 2)}…${text.slice(-2)}`
}

const report = {
  label,
  startedAt: new Date().toISOString(),
  outDir,
  stateFile,
  phase: 'waiting-for-live',
  room: null,
  identity: null,
  catalog: null,
  channels: { consoleComments: 0, compassMessages: 0, orders: 0 },
  events: { total: 0, byType: {}, uniqueViewers: 0, deduped: 0 },
  density: null,
  questions: null,
  samples: [],
  errors: [],
  finishedAt: null,
}

const browser = await chromium.launch({ headless: true, executablePath: CHROME || undefined })
const context = await browser.newContext({ storageState: JSON.parse(readFileSync(stateFile, 'utf8')), viewport: null })
const consolePage = await context.newPage()

const seen = new Set()
let collectingSince = null

function record(kind, payload, extra = {}) {
  const id = extra.id ? `${kind}:${extra.id}` : `${kind}:${JSON.stringify(payload).slice(0, 120)}`
  const dedupeKey = extra.id ? id : null
  if (dedupeKey) {
    if (seen.has(dedupeKey)) {
      report.events.deduped += 1
      return
    }
    seen.add(dedupeKey)
  }
  const event = { at: new Date().toISOString(), kind, ...extra, payload }
  report.events.total += 1
  report.events.byType[kind] = (report.events.byType[kind] ?? 0) + 1
  try {
    appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, { encoding: 'utf8' })
  } catch {
    /* 落盘失败不影响采集 */
  }
}

/* ------------------------------------------------ 中控台：房间号 + 货盘 + 弹幕 */
let roomId = null
let playinfoRoomId = null
let lastRoomId = null
/** 真实直播间号是 19 位数字；未开播时中控台给的是 0 */
const isValidRoomId = (value) => Boolean(value) && /^[0-9]{10,}$/.test(String(value))
consolePage.on('response', async (response) => {
  const url = response.url()
  if (!/jinritemai\.com/.test(url)) return
  if (!/json/i.test(response.headers()['content-type'] ?? '')) return
  try {
    if (/promotions_v2/.test(url)) {
      const body = await response.json()
      const data = body?.data ?? {}
      if (isValidRoomId(data.room_id)) roomId = String(data.room_id)
      const promotions = Array.isArray(data.promotions) ? data.promotions : []
      if (promotions.length) {
        report.catalog = {
          capturedAt: new Date().toISOString(),
          roomIdPresent: Boolean(roomId),
          count: promotions.length,
          // 只保留"能不能决策"需要的字段：稳定商品 ID、标题、库存、状态
          items: promotions.map((item) => ({
            productId: String(item.product_id ?? ''),
            promotionId: String(item.promotion_id ?? ''),
            title: String(item.title ?? '').slice(0, 40),
            stock: item.stock_num ?? null,
            status: item.status ?? null,
          })),
        }
      }
    } else if (/livepc\/playinfo/.test(url)) {
      const body = await response.json()
      const data = body?.data ?? {}
      if (isValidRoomId(data.room_id)) playinfoRoomId = String(data.room_id)
      // 注意：last_room_id 是上一场的房间号，只能做参考，绝不能当开播依据（冒烟时踩过）。
      if (isValidRoomId(data.last_room_id)) lastRoomId = String(data.last_room_id)
    } else if (/anchor\/livepc\/message_fetch/.test(url)) {
      // 百应中控台的真实弹幕通道：cursor 轮询，返回 message_list（每一轮是增量）
      const body = await response.json()
      const data = body?.data ?? {}
      if (data.next_cursor) report.cursor = String(data.next_cursor).slice(0, 24)
      const list = Array.isArray(data.message_list) ? data.message_list : []
      report.channels.consoleMessages = (report.channels.consoleMessages ?? 0) + list.length
      for (const item of list) {
        const type = String(item.msg_type ?? item.message_type ?? item.type ?? 'unknown')
        record(type === 'comment' ? 'comment' : `mf:${type}`, item, {
          id: String(item.msg_id ?? item.message_id ?? item.id ?? ''),
          source: 'message_fetch',
        })
      }
    } else if (/comment\/info/.test(url)) {
      const body = await response.json()
      const list = body?.data?.comment_infos ?? []
      report.channels.consoleComments += list.length
      for (const comment of list) {
        record('comment', { content: String(comment.content ?? ''), nick: String(comment.nick_name ?? '') }, {
          id: String(comment.comment_id ?? ''),
          source: 'console',
        })
      }
    } else if (/index\/getUser/.test(url)) {
      const body = await response.json()
      const data = body?.data ?? {}
      report.identity = report.identity ?? {
        observedAt: new Date().toISOString(),
        userIdMasked: mask(data.user_id),
        originUidMasked: mask(data.origin_uid),
        buyinAccountIdMasked: mask(data.buyin_account_id),
        loginUserIdMasked: mask(data.login_user_id),
        drAuth: data.dr_auth ?? null,
        accountChildType: data.account_child_type ?? null,
        shopType: data.shop_type ?? null,
        userRole: data.user_role ?? null,
      }
    }
  } catch {
    /* 非 JSON 或已关闭 */
  }
})

/* ------------------------------------------------------ 罗盘大屏：全量互动 + 订单 */
let compassPage = null
async function attachCompass(currentRoomId) {
  try {
    compassPage = await context.newPage()
    await compassPage.goto(COMPASS_INDEX, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await compassPage.waitForSelector('div[class^="userName"]', { timeout: 30_000 })
    await compassPage.goto(`${COMPASS_SCREEN}${currentRoomId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    compassPage.on('response', async (response) => {
      const url = response.url()
      if (!/json/i.test(response.headers()['content-type'] ?? '')) return
      try {
        if (url.includes('message?')) {
          const body = await response.json()
          const messages = body?.data?.messages ?? {}
          for (const [type, list] of Object.entries(messages)) {
            if (!Array.isArray(list)) continue
            report.channels.compassMessages += list.length
            for (const item of list) {
              record(type === 'comment' ? 'comment' : type, item, {
                id: String(item.comment_id ?? item.msg_id ?? item.user_id ?? JSON.stringify(item).slice(0, 80)),
                source: 'compass',
              })
            }
          }
        } else if (url.includes('live_order_stream?')) {
          const body = await response.json()
          const list = Array.isArray(body?.data) ? body.data : []
          report.channels.orders += list.length
          for (const item of list) {
            record('order', item, { id: `${item.order_id}#${item.order_status}`, source: 'compass' })
          }
        }
      } catch {
        /* 忽略 */
      }
    })
    // 记录罗盘大屏是否被权限挡住（这会解释"为什么这条通道 0 条消息"）
    const pageText = await compassPage.evaluate(() => (document.body?.innerText ?? '').slice(0, 3000)).catch(() => '')
    if (/没有权限|不支持访问/.test(pageText)) {
      report.compassBlocked = '此百应子账号没有直播大屏权限（页面提示：请联系主账号在【百应-子账号授权】配置）'
      log(`罗盘大屏被权限挡住：${report.compassBlocked}`)
    }
    // 断开中间直播画面，减少不必要的资源占用（上游同款处理）
    await compassPage
      .locator('video')
      .evaluate((el) => {
        const video = el
        setTimeout(() => {
          video.pause?.()
          video.removeAttribute?.('src')
          video.load?.()
          video.remove?.()
        }, 3000)
      })
      .catch(() => {})
    return true
  } catch (error) {
    report.errors.push(`compass_attach_failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/* ------------------------------------------------------------------ 主流程 */
let compassReady = false
const waitDeadline = Date.now() + waitMinutes * 60_000
await consolePage.goto(CONSOLE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((error) => {
  report.errors.push(`console_open_failed: ${error.message}`)
})

let polls = 0
let sawLive = false
/** "直播"判定必须严格：中控台页面里有个标签就叫「直播中控台」，直接匹配"直播中"会误判（已踩过）。 */
const detectLive = async () => {
  // 唯一判据：**当前** room_id 是否有效（promotions_v2 / playinfo 的 room_id）。
  // 不用文本匹配：页面里"直播中控台"这个标签、以及换行拆开的文本都会造成误判（冒烟时踩过两次）。
  if (isValidRoomId(roomId)) return { live: true, why: 'promotions_v2.room_id' }
  if (isValidRoomId(playinfoRoomId)) return { live: true, why: 'playinfo.room_id' }
  const text = await consolePage.evaluate(() => document.body?.innerText ?? '').catch(() => '')
  const hint = /直播中/.test(text) ? '页面文本含"直播中"（不作判据）' : '无开播迹象'
  return { live: false, why: hint }
}

// 先点进「直播中控台」子应用：只点这一个导航标签，不碰任何业务按钮。
// 不点的话页面不会去拉真正的直播态（promotions_v2 / comment 轮询都在子应用里）。
async function enterLiveConsoleTab() {
  try {
    const tab = consolePage.getByText('直播中控台', { exact: true }).first()
    if (await tab.count()) {
      await tab.click({ timeout: 5000 }).catch(() => {})
      await consolePage.waitForTimeout(4000)
      return true
    }
  } catch {
    /* 找不到就算了，页面可能已经在子应用里 */
  }
  return false
}

/**
 * 打开中控台的「互动/评论」面板。
 * 为什么必须点：`comment/info` 轮询只在互动面板打开时才发生（上游 ControlListener 也依赖同样前提，
 * 它还会定期点"新评论"按钮）。只点导航标签，不输入、不发送。
 */
async function openInteractionPanel() {
  const labels = ['互动', '互动评论', '评论', '评论区']
  for (const label of labels) {
    try {
      const tab = consolePage.getByText(label, { exact: true }).first()
      if (!(await tab.count())) continue
      await tab.click({ timeout: 4000 }).catch(() => {})
      await consolePage.waitForTimeout(3500)
      const ready = await consolePage
        .evaluate(() => ({
          commentBlock: Boolean(document.querySelector('#input-comment-block-id')),
          textareas: document.querySelectorAll('textarea').length,
        }))
        .catch(() => null)
      return { label, ...(ready ?? {}) }
    } catch {
      /* 换下一个标签 */
    }
  }
  return null
}

await enterLiveConsoleTab()

while (Date.now() < waitDeadline) {
  polls += 1
  const detection = await detectLive()
  if (detection.live) {
    sawLive = true
    log(`探测到开播（依据 ${detection.why}）`)
    break
  }
  await consolePage.waitForTimeout(pollSeconds * 1000)
  // 中控台开播后不一定自动刷新状态，隔几轮重新载入一次让它自己重新拉状态；
  // 太频繁地 reload 反而会打断它自己的轮询。
  if (!consolePage.isClosed() && polls % 3 === 0) {
    await consolePage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await consolePage.waitForTimeout(5000)
    await enterLiveConsoleTab()
  }
  log(`等待开播… 第 ${polls} 次探测（${detection.why}）`)
}

if (!sawLive) {
  report.phase = 'not-live-within-window'
  log('等待窗口内没有探测到开播，退出。')
} else {
  report.phase = 'collecting'
  const effectiveRoomId = roomId ?? playinfoRoomId
  report.room = { roomIdMasked: effectiveRoomId ? mask(effectiveRoomId) : null, roomIdLength: effectiveRoomId ? effectiveRoomId.length : 0, previousRoomIdMasked: lastRoomId ? mask(lastRoomId) : null }
  log(`探测到开播：room_id ${roomId ? '已拿到（' + roomId.length + ' 位）' : '未拿到'}`)
  // 先把互动面板打开，否则中控台不会去轮询 comment/info（这是 0 条消息的第二个原因）
  const panel = await openInteractionPanel()
  report.interactionPanel = panel
  log(`互动面板：${panel ? `点了「${panel.label}」（评论输入区=${panel.commentBlock}，textarea=${panel.textareas}）` : '没找到互动标签'}`)
  compassReady = effectiveRoomId ? await attachCompass(effectiveRoomId) : false
  log(`罗盘大屏通道：${compassReady ? '已接入' : '未接入（仅用中控台 comment/info）'}`)

  collectingSince = Date.now()
  const collectUntil = collectingSince + minutes * 60_000
  while (Date.now() < collectUntil) {
    await consolePage.waitForTimeout(15_000)
    const remain = Math.round((collectUntil - Date.now()) / 1000)
    log(`采集进行中… 剩余 ${remain}s｜message_fetch ${report.channels.consoleMessages ?? 0}｜comment/info ${report.channels.consoleComments}｜罗盘消息 ${report.channels.compassMessages}｜订单 ${report.channels.orders}`)
  }
  report.phase = 'collected'
}

/* ---------------------------------------------------------------- 指标汇总 */
const all = []
try {
  const text = readFileSync(eventsFile, 'utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      all.push(JSON.parse(line))
    } catch {
      /* 跳过坏行 */
    }
  }
} catch {
  /* 没有事件文件 */
}

const comments = all.filter((event) => event.kind === 'comment' && event.payload?.content)
const viewers = new Set(comments.map((event) => String(event.payload?.nick ?? event.payload?.nick_name ?? '')))
report.events.uniqueViewers = viewers.size

const QUESTION_PATTERNS = [
  ['价格', /多少钱|什么价|几块|价格|多钱|优惠|便宜|活动价|到手/],
  ['链接/序号', /几号链接|多少号|链接|小黄车|购物车|第几个|上链接/],
  ['库存', /有货吗|有没有货|还有吗|库存|断货|补货|没货/],
  ['规格', /规格|尺码|多大|几瓶|多少毫升|容量|口味|颜色/],
  ['发货/物流', /发货|快递|物流|包邮|几天到|什么时候发|运费/],
  ['售后', /退货|退款|售后|换货|坏了|破损|漏了/],
  ['赠品', /赠品|送什么|送不送|礼品|福利/],
]
const questionCounts = {}
const questionSamples = []
for (const comment of comments) {
  const content = String(comment.payload.content)
  if (!/[?？吗呢]|多少|什么|怎么/.test(content)) continue
  const hit = QUESTION_PATTERNS.find(([, pattern]) => pattern.test(content))
  if (!hit) continue
  questionCounts[hit[0]] = (questionCounts[hit[0]] ?? 0) + 1
  if (questionSamples.length < 15) questionSamples.push({ type: hit[0], content: content.slice(0, 40), at: comment.at })
}
report.questions = {
  shoppingQuestions: Object.values(questionCounts).reduce((sum, value) => sum + value, 0),
  byType: questionCounts,
  samples: questionSamples,
}

// 密度：按 60 秒滑动窗口统计"有效观众弹幕"条数（业务门槛是 60 秒 ≥10 条）
if (comments.length) {
  const times = comments.map((event) => Date.parse(event.at)).sort((a, b) => a - b)
  const counts = []
  for (let index = 0; index < times.length; index += 1) {
    let right = index
    while (right < times.length && times[right] - times[index] <= 60_000) right += 1
    counts.push(right - index)
  }
  counts.sort((a, b) => a - b)
  const at = (ratio) => counts[Math.min(counts.length - 1, Math.floor(counts.length * ratio))] ?? 0
  report.density = {
    commentEvents: comments.length,
    perMinuteAverage: Number(((comments.length / Math.max(1, minutes)) ).toFixed(1)),
    window60s: { max: counts[counts.length - 1] ?? 0, p50: at(0.5), p90: at(0.9) },
    windowsReachingThreshold10: counts.filter((value) => value >= 10).length,
    note: '按采集时刻计算，不是平台端到端时延；阈值 10 来自业务规则（60 秒 ≥10 条才开答）',
  }
}

report.finishedAt = new Date().toISOString()
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2), { encoding: 'utf8' })

const md = [
  `# 只读采集报告 · ${label}`,
  '',
  `- 采集窗口：${collectingSince ? new Date(collectingSince).toISOString() : '未开始'} → ${report.finishedAt}（${minutes} 分钟）`,
  `- 房间号：${report.room?.roomIdMasked ?? '未拿到'}（长度 ${report.room?.roomIdLength ?? 0}）`,
  `- 身份权限位：${JSON.stringify(report.identity?.drAuth ?? null)}`,
  `- 通道：中控台弹幕 ${report.channels.consoleComments} 条 / 罗盘消息 ${report.channels.compassMessages} 条 / 订单 ${report.channels.orders} 条`,
  `- 事件：总计 ${report.events.total}，去重丢弃 ${report.events.deduped}，唯一观众 ${report.events.uniqueViewers}`,
  `- 按类型：${JSON.stringify(report.events.byType)}`,
  `- 购物问题：${report.questions?.shoppingQuestions ?? 0} 条｜分类 ${JSON.stringify(report.questions?.byType ?? {})}`,
  `- 密度（60 秒滑动窗口）：max ${report.density?.window60s.max ?? 0} / p50 ${report.density?.window60s.p50 ?? 0} / p90 ${report.density?.window60s.p90 ?? 0}；达到门槛(≥10) 的窗口 ${report.density?.windowsReachingThreshold10 ?? 0} 个`,
  `- 货盘：${report.catalog ? report.catalog.count + ' 个商品（含 stock_num/status）' : '未抓到'}`,
  `- 错误：${report.errors.length ? report.errors.join('; ') : '无'}`,
  '',
  '## 问题样本（最多 15 条）',
  ...(report.questions?.samples?.length
    ? report.questions.samples.map((sample) => `- [${sample.type}] ${sample.content}`)
    : ['- （本次没有命中购物类问题）']),
].join('\n')
writeFileSync(join(outDir, 'report.md'), md, { encoding: 'utf8' })

log(`完成。产物：${outDir}`)
log(`事件 ${report.events.total}｜弹幕 ${comments.length}｜购物问题 ${report.questions.shoppingQuestions}｜订单 ${report.channels.orders}`)
await browser.close()

function liveTextSafe(value) {
  return Boolean(value)
}
