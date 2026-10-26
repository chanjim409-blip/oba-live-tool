/**
 * 开发者用的登录窗口（不是生产路径）。
 *
 * 宿主本来就是在"用户点连接 → 弹出受 Playwright 控制的 Chrome → 用户扫码 → 存 storageState"
 * 这个流程里拿登录态的（见 electron/main/services/AccountSession.ts）。这个脚本把同一步单独拿出来，
 * 好处是：扫码窗口可以直接给到人，登录态落在**本机私有目录**（不在仓库里），
 * 之后宿主/探索脚本都能复用它，而不用把用户自己的浏览器 profile 挪来挪去。
 *
 * 用法（在宿主仓根目录）：
 *   node scripts/dev-login.mjs                     # 打开抖店中控台 + 百应的登录页，等扫码
 *   node scripts/dev-login.mjs --only douyin       # 只开抖店
 *   node scripts/dev-login.mjs --profile <目录>    # 指定持久 profile（默认本机私有目录）
 *
 * 安全边界：只用本机已安装的 Chrome；不打印任何 Cookie/token；storageState 写到私有目录；
 * 报告里对真实 ID 只给掩码与长度，不给明文。
 *
 * 判定口径（上一版踩过的坑）：**不能只看"页面上有没有 header 类节点"**——
 * 百应登录页自己就带 header，会立刻误判成已登录。所以每个站点都用"账号名/中控台容器"这类
 * 只有登录后才会出现的节点判定，并且要求页面不在登录路径上。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const systemPrivateRoot = resolve(process.env.LIVE_ASSISTANT_PRIVATE_DIR || (process.platform === 'win32' ? 'D:/live-assistant/private' : join(process.env.HOME || '.', 'live-assistant-private')))
const PRIVATE_ROOT = resolve(
  process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(systemPrivateRoot, 'login'),
)

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const SITES = {
  douyin: {
    label: '抖音小店·中控台',
    login: 'https://fxg.jinritemai.com/login/common?extra=%7B%22target_url%22%3A%22https%3A%2F%2Ffxg.jinritemai.com%2Fffa%2Fbuyin%2Fdashboard%2Flive%2Fcontrol%22%7D',
    home: 'https://fxg.jinritemai.com/ffa/buyin/dashboard/live/control',
    /** 登录后中控台右上角的账号名节点（宿主也用它判登录） */
    accountName: '[class^="index_userName"]',
    /** 只有进到中控台才会有的商品面板 */
    inLive: '[class^="goodsPanel"]',
    loginPath: /\/login\b|\/passport\b/,
  },
  buyin: {
    label: '巨量百应·子账号',
    login: 'https://buyin.jinritemai.com/mpa/account/login?log_out=1&type=24',
    home: 'https://buyin.jinritemai.com/dashboard/live/control',
    accountName: 'span.btn-item-role-exchange-name__title',
    inLive: '[class^="goodsPanel"]',
    loginPath: /\/mpa\/account\/login|douyinec\.com/,
  },
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? true) : fallback
}

const only = arg('only', null)
const targets = only ? [String(only)] : Object.keys(SITES)
for (const key of targets) if (!SITES[key]) throw new Error(`不认识的站点：${key}`)

const profileDir = arg('profile', join(PRIVATE_ROOT, 'chrome-profile'))
mkdirSync(profileDir, { recursive: true })
mkdirSync(PRIVATE_ROOT, { recursive: true })

const mask = (value) => {
  const text = String(value ?? '').trim()
  if (text.length <= 4) return `${text.length} chars`
  return `${text.slice(0, 2)}…${text.slice(-2)} (${text.length} chars)`
}
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`)

const executablePath = CHROME_CANDIDATES.find((item) => existsSync(item))
log(`浏览器：${executablePath ?? '（Playwright 默认）'}`)
log(`私有 profile：${profileDir}`)

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
  executablePath: executablePath || undefined,
  args: ['--start-maximized'],
})
let closing = false
context.on('close', () => {
  closing = true
  log('浏览器已关闭，进程退出。')
})

const report = { startedAt: new Date().toISOString(), profileDir, sites: {} }
const writeReport = () => writeFileSync(join(PRIVATE_ROOT, 'login-report.json'), JSON.stringify(report, null, 2), { encoding: 'utf8' })

const pages = new Map()
for (const key of targets) {
  const site = SITES[key]
  const page = await context.newPage()
  pages.set(key, page)
  await page.goto(site.login, { waitUntil: 'domcontentloaded' }).catch((error) => log(`${site.label} 打开失败：${error.message}`))
  report.sites[key] = { label: site.label, url: page.url(), loggedIn: false }
  log(`已打开「${site.label}」，请在窗口里扫码登录`)
}
writeReport()

/** 单个站点的侦察：只读，不点业务按钮。 */
async function inspect(key) {
  const site = SITES[key]
  const page = pages.get(key)
  if (!page || page.isClosed()) return { closed: true }
  const href = page.url()
  const inApp = !site.loginPath.test(href)
  const markers = await page
    .evaluate(({ accountName, inLive }) => {
      const nameNode = document.querySelector(accountName)
      return {
        accountName: nameNode ? (nameNode.textContent ?? '').trim() : null,
        hasNameNode: Boolean(nameNode),
        hasLivePanel: Boolean(document.querySelector(inLive)),
        md5Canvas: Boolean(document.querySelector('canvas, img[class*="qr"], [class*="qrcode"], [class*="qrCode"]')),
      }
    }, site)
    .catch(() => ({ accountName: null, hasNameNode: false, hasLivePanel: false, md5Canvas: false }))
  return { href, inApp, ...markers }
}

let tick = 0
while (!closing) {
  await new Promise((resolve) => setTimeout(resolve, 5000))
  if (closing) break
  tick += 1
  for (const key of targets) {
    const site = SITES[key]
    const state = await inspect(key).catch(() => ({ closed: true }))
    report.sites[key] = { ...report.sites[key], ...state, checkedAt: new Date().toISOString() }
    if (state.closed) continue
    // 判定：不在登录路径 + 出现账号名节点。商品面板用于判断"是否已到中控台"。
    const loggedIn = state.inApp && state.hasNameNode
    if (!loggedIn) {
      if (tick % 6 === 1) log(`${site.label}：等待扫码（页面 ${state.inApp ? '已离开登录页' : '仍在登录页'}）`)
      continue
    }
    if (state.hasLivePanel && !state.href.startsWith(site.home)) {
      await pages.get(key).goto(site.home, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 4000))
    }
    const finalState = await inspect(key)
    const storageStateFile = join(PRIVATE_ROOT, `${key}.storage.json`)
    writeFileSync(storageStateFile, JSON.stringify(await context.storageState()), { encoding: 'utf8' })
    report.sites[key] = {
      label: site.label,
      loggedIn: true,
      loggedInAt: new Date().toISOString(),
      inLiveControlPage: finalState.hasLivePanel,
      href: finalState.href,
      accountDisplayName: mask(finalState.accountName),
      storageStateFile,
    }
    writeReport()
    log(`${site.label} 登录成功：${finalState.hasLivePanel ? '已进入中控台' : '账号名已出现，但商品面板还没渲染'}`)
    log(`  页面：${finalState.href}`)
    log(`  账号名：${mask(finalState.accountName)}（掩码，不落明文）`)
    log(`  登录态：${storageStateFile}`)
    pages.delete(key)
  }
  writeReport()
}
