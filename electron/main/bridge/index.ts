import { join } from 'node:path'
import { app } from 'electron'
import { startBridgeServer, type BridgeServerConfig, type RunningBridgeServer } from './bridgeServer'
import { PlaywrightIdentitySource } from './identitySource'

/**
 * Electron 内的薄封装：把宿主自己的运行目录、真实身份源接上，然后交给 `startBridgeServer`。
 * 真正的路由与服务在 `bridgeServer.ts` 里，那边不依赖 Electron，方便独立跑（只读观察时不开 GUI）。
 */
export interface HostBridgeConfig {
  dataDir: string
  port: number
  token: string
  douyinAccountId: string | null
  buyinAccountId: string | null
  allowedOrigins: string[]
  /** 登录态 storageState 文件（本机私有目录）。没有它就只能起来但没法采数据。 */
  storageStatePath: string | null
  headless: boolean
}

export interface RunningHostBridge {
  port: number
  stop(): Promise<void>
}

const MIN_TOKEN_LENGTH = 32

export function readBridgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HostBridgeConfig | null {
  const token = env.LIVE_ASSISTANT_BRIDGE_TOKEN?.trim() ?? ''
  if (!token) return null
  if (token.length < MIN_TOKEN_LENGTH) throw new Error('host_bridge_token_too_short')
  return {
    dataDir: env.LIVE_ASSISTANT_BRIDGE_DATA || join(env.LIVE_ASSISTANT_PRIVATE_DIR || (process.platform === 'win32' ? 'D:/live-assistant/private' : app.getPath('userData')), 'bridge-data'),
    port: Number(env.LIVE_ASSISTANT_BRIDGE_PORT ?? 9310),
    token,
    douyinAccountId: env.LIVE_ASSISTANT_DOUYIN_ACCOUNT?.trim() || null,
    buyinAccountId: env.LIVE_ASSISTANT_BUYIN_ACCOUNT?.trim() || null,
    allowedOrigins: (env.LIVE_ASSISTANT_BRIDGE_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    storageStatePath: env.LIVE_ASSISTANT_LOGIN_STATE?.trim() || null,
    headless: env.LIVE_ASSISTANT_BRIDGE_HEADLESS !== '0',
  }
}

export async function startHostBridge(config: HostBridgeConfig): Promise<RunningHostBridge> {
  const server: RunningBridgeServer = await startBridgeServer({
    port: config.port,
    token: config.token,
    dataDir: config.dataDir,
    storageStatePath: config.storageStatePath,
    headless: config.headless,
    allowedOrigins: config.allowedOrigins,
    douyinAccountId: config.douyinAccountId,
    buyinAccountId: config.buyinAccountId,
    // Electron 内运行时才有真实页面身份源；独立运行时由 bridgeServer 自己拒绝（失败关闭）。
    identitySource: new PlaywrightIdentitySource({
      douyinAccountId: config.douyinAccountId,
      buyinAccountId: config.buyinAccountId,
    }),
    log: (message) => console.log(`[bridge] ${message}`),
  })
  return { port: server.port, stop: server.stop }
}

export type { BridgeServerConfig }
