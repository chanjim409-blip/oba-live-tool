/**
 * 独立运行桥接服务（不开 Electron 界面，只读采集 + 只读 HTTP 接口）。
 *
 * 为什么单独一个入口：观察阶段不需要宿主 GUI，Electron 起来会弹窗口、占内存；
 * 而 `bridgeServer.ts` 本身不依赖 Electron（只依赖 playwright + node 内置模块），可以直接跑。
 * 正式部署时同一份代码由 Electron 主进程调用（见 electron/main/bridge/index.ts）。
 *
 * 环境变量（都从环境读，不落仓库）：
 *   LIVE_ASSISTANT_BRIDGE_TOKEN      必填，≥32 字符；业务侧 OBA_BRIDGE_TOKEN 必须一致
 *   LIVE_ASSISTANT_BRIDGE_PORT       默认 9310
 *   LIVE_ASSISTANT_LOGIN_STATE       登录态 storageState 文件（本机私有目录）
 *   LIVE_ASSISTANT_BRIDGE_HEADLESS   默认 1（1=无头，0=有头便于人工核对）
 *   LIVE_ASSISTANT_BRIDGE_ORIGINS    允许的 Origin（逗号分隔；默认空=拒绝一切带 Origin 的请求）
 *
 * 用法：npx tsx scripts/bridge-server.ts
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { startBridgeServer } from '../electron/main/bridge/bridgeServer'
import type { RoomBrowserConfig } from '../electron/main/bridge/roomBrowserDriver'

const token = (process.env.LIVE_ASSISTANT_BRIDGE_TOKEN ?? '').trim()
if (token.length < 32) {
  console.error('缺少 LIVE_ASSISTANT_BRIDGE_TOKEN（至少 32 字符，且要与业务侧 OBA_BRIDGE_TOKEN 完全一致）')
  process.exit(2)
}
const port = Number(process.env.LIVE_ASSISTANT_BRIDGE_PORT ?? 9310)
const privateRoot = resolve(process.env.LIVE_ASSISTANT_PRIVATE_DIR || (process.platform === 'win32' ? 'D:/live-assistant/private' : join(process.env.HOME || '.', 'live-assistant-private')))
const dataDir = resolve(process.env.LIVE_ASSISTANT_BRIDGE_DATA || join(privateRoot, 'bridge-data'))
mkdirSync(dataDir, { recursive: true })
const storageStatePath = process.env.LIVE_ASSISTANT_LOGIN_STATE ? resolve(process.env.LIVE_ASSISTANT_LOGIN_STATE) : null
if (storageStatePath) mkdirSync(dirname(storageStatePath), { recursive: true })

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const { existsSync } = await import('node:fs')
const executablePath = chromeCandidates.find((item) => existsSync(item)) ?? null
const replyBrowser: RoomBrowserConfig | undefined = process.env.LIVE_ASSISTANT_REPLY_CONFIG
  ? JSON.parse(readFileSync(process.env.LIVE_ASSISTANT_REPLY_CONFIG, 'utf8').replace(/^\uFEFF/, '')) : undefined

const server = await startBridgeServer({
  port,
  token,
  dataDir,
  storageStatePath,
  executablePath,
  replyBrowser,
  replyExecutionEnabled: process.env.LIVE_ASSISTANT_REPLY_ENABLED === '1',
  headless: process.env.LIVE_ASSISTANT_BRIDGE_HEADLESS !== '0',
  allowedOrigins: (process.env.LIVE_ASSISTANT_BRIDGE_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
  log: (message) => console.log(`[bridge ${new Date().toISOString().slice(11, 19)}] ${message}`),
})

const shutdown = async (signal: string) => {
  console.log(`[bridge] 收到 ${signal}，正在停止`)
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// 每 30 秒把采集状态打到日志，便于外部观察（不含任何弹幕内容）
setInterval(() => {
  if (server.tap) console.log(`[bridge] ${JSON.stringify(server.tap.status())}`)
}, 30_000)
