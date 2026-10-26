/**
 * 业务桥接服务（宿主侧）。只监听回环地址，私有 Bearer token 认证。
 *
 * 已实现的路由（业务侧 `src/platform/obaBridge.ts` 会调这些）：
 *   GET  /health             → { logged_in, live, … }（业务侧连不上或 logged_in!==true 会拒绝开场次）
 *   POST /sessions           → 登记场次作用域（当前只做记录）
 *   DELETE /sessions         → 注销
 *   GET  /events             → SSE，`id:` 用平台消息 ID，`data:` 是 RawPlatformEvent
 *   GET  /catalog            → 本场挂车货盘（来自 promotions_v2，含库存与可售判定）
 *   GET  /current-product    → 当前讲解商品：**未知就返回空**（不猜）
 *   GET  /capabilities       → 能力逐项分级：只有真正观察到证据的项才给 verified
 *   /identity /reply /product/show /users/* /actions/* → 身份边界（vendor 自业务仓）；执行默认关闭
 *
 * /reply 可显式配置后台浏览器并启用受控执行；默认关闭，首次点击只记 uncertain。
 * /product/show、/users/block 等其它动作继续拒绝。程序接通不代表实场验收。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { LiveTap, weakViewerId } from './liveTap'
import { openHostBridgeDb } from './sqliteDb'
import { HostIdentityBoundary } from './vendor/hostIdentity'
import { createHostIdentityHandler } from './vendor/hostIdentityHttp'
import type { HostIdentitySource } from './vendor/hostIdentity'
import { TapIdentitySource, type RegisteredScope } from './tapIdentitySource'
import { ScopeGuard, parseScope } from './scopeGuard'
import { RoomBrowserDriver, type RoomBrowserConfig } from './roomBrowserDriver'
import { BackgroundReplySource } from './backgroundReplySource'

export interface BridgeServerConfig {
  port: number
  token: string
  /** 私有运行目录（放 host-identity.sqlite 等），默认 <cwd>/.bridge-data */
  dataDir: string
  /** 登录态 storageState 文件；没有就不启动采集（/health 会如实说未登录） */
  storageStatePath: string | null
  executablePath?: string | null
  headless?: boolean
  allowedOrigins?: string[]
  douyinAccountId?: string | null
  buyinAccountId?: string | null
  /**
   * 身份源：在 Electron 里运行时注入真实的 Playwright 身份源；
   * 独立运行（不经 Electron）时不注入，一律拒绝——绝不编一个"看起来合法"的身份。
   */
  identitySource?: HostIdentitySource
  /** Explicit private room configuration; omitted preserves the read-only bridge. */
  replyBrowser?: RoomBrowserConfig
  replyExecutionEnabled?: boolean
  log?: (message: string) => void
  /** Dependency injection for offline contract tests; production uses LiveTap. */
  tapFactory?: (options: ConstructorParameters<typeof LiveTap>[0]) => LiveTap
}

export interface RunningBridgeServer {
  port: number
  tap: LiveTap | null
  stop(): Promise<void>
}

const MIN_TOKEN = 32

/**
 * 独立运行时（不经 Electron）没有真实身份源：一律拒绝，绝不编一个"看起来合法"的身份。
 * 身份读不到 → 业务侧的动作会被鉴权边界拒绝；只读数据流不受影响。
 */
const refusingIdentitySource: HostIdentitySource = {
  async withContext() {
    throw new Error('host_identity_unprovable')
  },
}

export async function startBridgeServer(config: BridgeServerConfig): Promise<RunningBridgeServer> {
  if (config.token.length < MIN_TOKEN || /[\r\n]/.test(config.token)) throw new Error('bridge_token_invalid')
  const log = config.log ?? ((message: string) => console.log(`[bridge] ${message}`))
  const expected = Buffer.from(`Bearer ${config.token}`)

  /* ------------------------------------------------------- 采集器（可缺席） */
  let tap: LiveTap | null = null
  if (config.storageStatePath) {
    tap = (config.tapFactory ?? (options => new LiveTap(options)))({
      storageStatePath: config.storageStatePath,
      executablePath: config.executablePath ?? null,
      headless: config.headless ?? true,
      log,
    })
    try {
      await tap.start()
    } catch (error) {
      log(`采集器启动失败：${error instanceof Error ? error.message : String(error)}`)
      await tap.stop().catch(() => undefined)
      tap = null
    }
  } else {
    log('未提供登录态文件，采集器不启动（/health 会如实返回 logged_in=false）')
  }

  /* ------------------------------------------------ 身份边界（默认关闭） */
  const opened = openHostBridgeDb(join(config.dataDir, 'host-identity.sqlite'))
  /** 业务侧登记的场次作用域：身份源用它和页面上的真实达人/房间做交叉核对 */
  const scopeGuard = new ScopeGuard(() => ({ loggedIn: tap?.loggedIn ?? false, accountId: tap?.facts?.userId ?? null, roomId: tap?.currentRoomId ?? null }))
  let replyDriver: RoomBrowserDriver | null = null
  if (config.replyBrowser) {
    replyDriver = new RoomBrowserDriver(config.replyBrowser)
    try { await replyDriver.start() }
    catch { await replyDriver.stop().catch(() => undefined); replyDriver = null; log('后台回复浏览器未就绪，执行保持拒绝') }
  }
  const replySource = replyDriver && config.replyBrowser ? new BackgroundReplySource(replyDriver, () => scopeGuard.current,
    { ownerId: config.replyBrowser.expectedOwnerId, executorId: config.replyBrowser.expectedExecutorId, minIntervalMs: 15_000 }) : null
  const readSource = config.identitySource ?? (tap ? new TapIdentitySource(tap, () => scopeGuard.current) : refusingIdentitySource)
  const source: HostIdentitySource = {
    withContext: (surface, run) => surface === 'douyin_room' && replySource
      ? replySource.withContext(surface, run) : readSource.withContext(surface, run),
  }
  const boundary = new HostIdentityBoundary({
    db: opened.db,
    // 有采集器就用"页面真实观察"的身份源；没有就一律拒绝（绝不编一个看起来合法的身份）。
    source,
    now: () => Date.now(),
    mode: 'platform',
    executionEnabled: !!replySource && config.replyExecutionEnabled === true,
  })
  const identityHandler = createHostIdentityHandler(boundary, {
    token: config.token,
    allowedOrigins: config.allowedOrigins ?? [],
  })

  /* ----------------------------------------------------------------- 路由 */
  const subscribers = new Map<ServerResponse, RegisteredScope>()
  const closeSubscribers = () => {
    for (const response of subscribers.keys()) response.end()
    subscribers.clear()
  }
  const unsubscribe = tap?.subscribe((event) => {
    const frame = `id: ${event.id}\ndata: ${JSON.stringify({
      viewerId: weakViewerId(event.nickname),
      viewerNickname: event.nickname || null,
      role: 'viewer',
      text: event.text,
      occurredAt: event.occurredAt,
      identityQuality: 'weak',
      eventId: event.id,
    })}\n\n`
    for (const [response, scope] of subscribers) {
      try {
        scopeGuard.assertRegistered(scope)
        if (!tap?.eventSourceHealthy) throw new Error('bridge_event_source_stale')
        if (event.roomId !== scope.roomId) continue
        if (!response.write(frame)) response.destroy()
      } catch {
        response.end()
        subscribers.delete(response)
      }
    }
  })

  const server = createServer(async (request, response) => {
    const json = (status: number, body: unknown) => {
      if (response.writableEnded) return
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    try {
      // 身份边界优先（它自己会校验 token 与 Origin）
      if (await identityHandler(request, response)) return

      const actual = Buffer.from(request.headers.authorization ?? '')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        json(401, { error_code: 'bridge_unauthorized' })
        return
      }
      const origin = request.headers.origin
      if (origin && !(config.allowedOrigins ?? []).includes(origin)) {
        json(403, { error_code: 'bridge_origin_denied' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const scopeEcho = {
        platform: url.searchParams.get('platform') ?? null,
        account_id: url.searchParams.get('account_id') ?? null,
        room_id: url.searchParams.get('room_id') ?? null,
        session_id: url.searchParams.get('session_id') ?? null,
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        if (tap && !tap.loggedIn) await tap.refreshIdentity()
        json(200, { ok: true, bridge: 'live-assistant-host', ...(tap ? tap.status() : { logged_in: false, live: false }),
          reply_transport: replyDriver ? (config.replyBrowser?.attachedEndpoint ? 'hidden_owned_browser' : 'headless_browser') : null,
          reply_execution_enabled: !!replySource && config.replyExecutionEnabled === true })
        return
      }

      if (request.method === 'GET' && url.pathname === '/reply/preflight') {
        json(200, replyDriver ? await replyDriver.inspect() : { transport: null, ready: false, reason: 'reply_browser_unavailable' })
        return
      }
      if (request.method === 'POST' && url.pathname === '/reply/refresh') {
        if (!replyDriver) { json(409, { error_code: 'bridge_reply_unavailable' }); return }
        await replyDriver.refresh()
        json(200, await replyDriver.inspect())
        return
      }

      if (url.pathname === '/sessions') {
        if (request.method === 'POST') {
          const body = await readJson(request)
          // 登记作用域：后面每次 /identity 都用它和页面上的真实达人/房间交叉核对。
          scopeGuard.register(parseScope(body))
          log('业务侧登记场次：作用域与采集器一致')
          json(200, { ok: true, registered: true, ...(tap ? { live: tap.live, room_id: tap.currentRoomId } : {}) })
          return
        }
        if (request.method !== 'DELETE') { json(405, { error_code: 'bridge_method_not_allowed' }); return }
        scopeGuard.release(parseScope(scopeEcho))
        closeSubscribers()
        json(200, { ok: true, released: true })
        return
      }

      // Capability discovery may precede registration; it still requires the actually observed owner/room.
      if (['/events', '/catalog', '/current-product', '/capabilities'].includes(url.pathname)) {
        const scope = parseScope(scopeEcho)
        if (url.pathname === '/capabilities') scopeGuard.assertObserved(scope)
        else scopeGuard.assertRegistered(scope)
      }

      if (request.method === 'GET' && url.pathname === '/events') {
        if (!tap?.eventSourceHealthy) { json(503, { error_code: 'bridge_event_source_stale' }); return }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        response.write(': bridge-events\n\n')
        // 断线续传：带 Last-Event-ID 时补发缓冲里之后的消息；不带就从现在开始（绝不重放历史）
        const lastId = (request.headers['last-event-id'] as string | undefined) ?? null
        for (const event of tap?.recent(lastId) ?? []) {
          if (event.roomId !== scopeEcho.room_id) continue
          response.write(`id: ${event.id}\ndata: ${JSON.stringify({
            viewerId: weakViewerId(event.nickname),
            viewerNickname: event.nickname || null,
            role: 'viewer',
            text: event.text,
            occurredAt: event.occurredAt,
            identityQuality: 'weak',
            eventId: event.id,
          })}\n\n`)
        }
        const subscriptionScope = parseScope(scopeEcho)
        subscribers.set(response, subscriptionScope)
        const keepAlive = setInterval(() => {
          try {
            scopeGuard.assertRegistered(subscriptionScope)
            if (!tap?.eventSourceHealthy) throw new Error('bridge_event_source_stale')
            if (!response.write(': keep-alive\n\n')) response.destroy()
          } catch {
            response.end()
            clearInterval(keepAlive)
            subscribers.delete(response)
          }
        }, 15_000)
        keepAlive.unref?.()
        request.on('close', () => {
          clearInterval(keepAlive)
          subscribers.delete(response)
        })
        return
      }

      if (request.method === 'GET' && url.pathname === '/catalog') {
        if (!tap?.catalog || tap.catalog.roomId !== scopeEcho.room_id) {
          json(503, { error_code: 'bridge_catalog_unavailable' })
          return
        }
        json(200, {
          version: tap.catalog.version,
          observed_at: tap.catalog.observedAt,
          items: tap.catalog.items.map((item) => ({
            product_id: item.productId,
            promotion_id: item.promotionId,
            ordinal: item.ordinal,
            available: item.available,
            title: item.title,
          })),
        })
        return
      }

      // 当前讲解商品：宿主没有可靠来源 → 明确返回"没有"，让业务侧按 unknown 处理，而不是编一个
      // 真实身份事实（供业务侧绑账号用；只回本机、需 token）
      if (request.method === 'GET' && url.pathname === '/facts') {
        json(200, {
          logged_in: tap?.loggedIn ?? false,
          live: tap?.live ?? false,
          room_id: tap?.currentRoomId ?? null,
          facts: tap?.facts ?? null,
          observed_from: 'buyin 中控台 /index/getUser 与 promotions_v2（页面自身请求的响应）',
        })
        return
      }

      if (request.method === 'GET' && url.pathname === '/current-product') {
        json(200, { product_id: null, observed_at: new Date().toISOString() })
        return
      }

      if (request.method === 'GET' && url.pathname === '/capabilities') {
        const status = tap?.status()
        const commentSeen = !!tap?.eventSourceHealthy && (status?.counts.comment ?? 0) > 0
        const items = [
          { key: 'login', status: status?.logged_in ? 'verified' : 'unverified', evidence_ref: status?.logged_in ? `console-login@${status.started_at}` : null, note: '宿主确认登录态（页面账号节点存在）' },
          { key: 'monitor_comments', status: commentSeen ? 'verified' : 'unverified', evidence_ref: commentSeen ? `observed-comments:${status?.counts.comment}` : null, note: '从罗盘大屏 message? 实时收到弹幕' },
          { key: 'stable_product_id', status: tap?.catalog ? 'verified' : 'unverified', evidence_ref: tap?.catalog ? `promotions_v2@${tap.catalog.observedAt}` : null, note: 'product_id 来自 promotions_v2（平台自有 ID）' },
          { key: 'receipt', status: 'unverified', evidence_ref: null, note: '点击仅记 uncertain；待平台或观众独立核验，不冒充已验收' },
          { key: 'send_reply', status: 'unverified', evidence_ref: null, note: replyDriver ? '后台发送程序已接入，等待受控实场验收' : '后台发送浏览器未配置或未就绪' },
          { key: 'ensure_product_visible', status: 'unverified', evidence_ref: null, note: '未实现' },
          { key: 'ordinal_mapping', status: 'unverified', evidence_ref: null, note: '序号取自 promotions_v2 顺序，未与页面显示核对' },
          { key: 'background_lifetime', status: 'unverified', evidence_ref: null, note: '未长期验证' },
          { key: 'sku_stock_snapshot', status: 'unverified', evidence_ref: null, note: '只有商品级 stock_num，没有 SKU 级快照' },
          { key: 'mention_user', status: 'unverified', evidence_ref: null, note: '未实现' },
          { key: 'block_user', status: 'missing', evidence_ref: null, note: '百应权限菜单无此功能；属直播间管理员身份' },
          { key: 'unblock_user', status: 'missing', evidence_ref: null, note: '同上' },
          { key: 'host_event_identity', status: 'unverified', evidence_ref: null, note: '主播语音/事件身份未接' },
          { key: 'product_dwell_control', status: 'unverified', evidence_ref: null, note: '未实现' },
        ]
        json(200, {
          platform: 'douyin',
          account_id: tap?.facts?.userId,
          room_id: tap?.currentRoomId,
          checked_at: new Date().toISOString(),
          items,
        })
        return
      }

      json(404, { error_code: 'bridge_route_not_implemented', path: url.pathname })
    } catch (error) {
      const code = error instanceof Error && /^bridge_[a-z_]+$/.test(error.message) ? error.message : 'bridge_failed'
      log(`请求失败：${code}`)
      if (!response.headersSent) json(code === 'bridge_body_too_large' ? 413 : code === 'bridge_json_invalid' || code === 'bridge_scope_invalid' ? 400 : code === 'bridge_failed' ? 500 : 409, { error_code: code })
      else response.end()
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '127.0.0.1', () => resolve())
  })
  log(`已监听 http://127.0.0.1:${config.port}（reply execution=${replySource && config.replyExecutionEnabled === true ? 'enabled with identity gates' : 'disabled'}）`)

  return {
    port: (server.address() as { port: number }).port,
    tap,
    stop: async () => {
      unsubscribe?.()
      for (const response of subscribers.keys()) {
        try {
          response.end()
        } catch {
          /* ignore */
        }
      }
      subscribers.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await tap?.stop()
      await replyDriver?.stop()
      opened.close()
    },
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk)
    if (size > 65_536) throw new Error('bridge_body_too_large')
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value as Record<string, unknown>
  } catch {
    throw new Error('bridge_json_invalid')
  }
}


