import { createHash } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright'
import { ownedBrowserWindows } from './ownedBrowserWindow'
import { discoverRoom, parseRoomEvidence, type RoomEvidence } from './roomDiscovery'
import type { BackgroundReplyDriver, ReplySnapshot } from './backgroundReplySource'

export interface RoomBrowserConfig {
  profileDir: string
  executablePath: string
  capturePaths: string[]
  anchorName: string
  expectedOwnerId: string
  expectedExecutorId: string
  inputSelector?: string
  submitSelector?: string
  /** Explicitly owned debug browser, retained after human login; loopback only. */
  attachedEndpoint?: string
}

/** Dedicated headless context; never controls the user's desktop or uses stealth/challenge bypasses. */
export class RoomBrowserDriver implements BackgroundReplyDriver {
  private context: BrowserContext | null = null
  private selfPage: Page | null = null
  private roomPage: Page | null = null
  private url = ''
  private self: { id: string; at: number } | null = null
  private room: { value: RoomEvidence; at: number } | null = null
  private generations = { self: 0, room: 0 }
  private pending: Promise<void> | null = null
  private refreshFailure: string | null = null
  private restricted = false
  private roomDiagnostic: Record<string, unknown> | null = null
  private attachedBrowser: Browser | null = null
  private ownedPid: number | null = null
  constructor(private readonly config: RoomBrowserConfig) {}

  async start(): Promise<void> {
    this.url = (await discoverRoom(this.config.capturePaths, this.config.anchorName)).url
    if (this.config.attachedEndpoint) {
      const endpoint = new URL(this.config.attachedEndpoint)
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/') throw new Error('reply_endpoint_invalid')
      this.attachedBrowser = await chromium.connectOverCDP(endpoint.href)
      const cdp = await this.attachedBrowser.newBrowserCDPSession()
      const processes = await cdp.send('SystemInfo.getProcessInfo')
      this.ownedPid = processes.processInfo.find(p => p.type === 'browser')?.id ?? null
      await cdp.detach()
      if (!this.ownedPid) throw new Error('owned_browser_missing')
      await ownedBrowserWindows(this.ownedPid, this.config.profileDir, true)
      const contexts = this.attachedBrowser.contexts()
      if (contexts.length !== 1) throw new Error('reply_context_ambiguous')
      this.context = contexts[0]
      this.roomPage = this.context.pages().find(p => p.url().split('?')[0] === this.url) ?? null
      const candidates = this.context.pages().filter(p => {
        if (p === this.roomPage) return false
        const url = new URL(p.url())
        // The site's /user/self navigation redirects to the authenticated user's profile.
        return p.url() === 'about:blank' || (url.origin === 'https://www.douyin.com' && url.pathname.startsWith('/user/'))
      })
      this.selfPage = candidates.length === 1 ? candidates[0] : null
      if (!this.roomPage || !this.selfPage) throw new Error('reply_retained_pages_missing')
    } else {
      this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: true, executablePath: this.config.executablePath,
      })
      this.selfPage = await this.context.newPage()
      this.roomPage = await this.context.newPage()
    }
    this.listen(this.selfPage, 'self')
    this.listen(this.roomPage, 'room')
    await this.refresh()
  }

  private listen(page: Page, kind: 'self' | 'room') {
    const requests = new WeakMap<Request, number>()
    page.on('request', request => requests.set(request, this.generations[kind]))
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return
      this.generations[kind]++
      if (kind === 'self') this.self = null
      else this.room = null
    })
    page.on('response', async response => {
      const path = new URL(response.url())
      const expected = kind === 'self' ? '/aweme/v1/web/user/profile/self/' : '/webcast/room/web/enter/'
      if (kind === 'room' && path.pathname === expected) this.roomDiagnostic = { host: path.hostname, httpStatus: response.status() }
      if (path.pathname !== expected || !['www.douyin.com', 'live.douyin.com'].includes(path.hostname)) return
      if (kind === 'room' && path.searchParams.get('web_rid') !== this.url.split('/').at(-1)) return
      const generation = requests.get(response.request())
      if (generation !== this.generations[kind]) return
      try {
        if ([401, 403, 429].includes(response.status())) { this.restricted = true; return }
        const body = await response.json()
        if (kind === 'room') this.roomDiagnostic = { ...this.roomDiagnostic,
          status: body.status_code, roomCount: body.data?.data?.length,
          roomStatus: body.data?.data?.[0]?.status,
          roomIdPresent: !!body.data?.data?.[0]?.id_str,
          ownerInRoom: !!body.data?.data?.[0]?.owner_user_id_str,
          ownerInUser: !!body.data?.user?.id_str,
          ownerCrossMatches: body.data?.user?.id_str === body.data?.data?.[0]?.owner_user_id_str }
        if (generation !== this.generations[kind]) return
        if (body.status_code !== 0) { this.restricted = true; return }
        if (kind === 'self') {
          if (typeof body.user?.uid !== 'string' || !/^\d+$/.test(body.user.uid)) throw new Error('self_invalid')
          this.self = { id: body.user.uid, at: Date.now() }
        } else this.room = { value: parseRoomEvidence(body), at: Date.now() }
      } catch {
        if (kind === 'self') this.self = null
        else this.room = null
      }
    })
    page.on('close', () => { if (kind === 'self') this.self = null; else this.room = null })
  }

  async refresh(): Promise<void> {
    if (this.restricted) throw new Error('room_platform_restricted')
    if (this.pending) return this.pending
    const pages = [this.selfPage, this.roomPage]
    if (pages.some(page => !page || page.isClosed())) throw new Error('room_browser_closed')
    this.refreshFailure = null
    this.pending = (async () => {
      // Only the site's own navigation generates authentication/room requests; no guessed signed HTTP endpoint.
      const targets = ['https://www.douyin.com/user/self?from_nav=1', this.url]
      await Promise.all(pages.map(async (page, i) => {
        const responsePath = i === 0 ? '/aweme/v1/web/user/profile/self/' : '/webcast/room/web/enter/'
        const surface = i === 0 ? 'self' : 'room'
        const response = page!.waitForResponse(r => new URL(r.url()).pathname === responsePath, { timeout: 12_000 })
          .catch(() => { throw new Error(`bridge_reply_${surface}_response_unavailable`) })
        const navigation = page!.goto(targets[i], { waitUntil: 'domcontentloaded', timeout: 12_000 })
          .catch(() => { throw new Error(`bridge_reply_${surface}_navigation_failed`) })
        await Promise.all([response, navigation])
      }))
      // Response listeners await JSON decoding. Wait only for bounded observations, never for a send.
      const end = Date.now() + 2000
      while ((!this.self || !this.room) && Date.now() < end && !this.restricted) await new Promise(resolve => setTimeout(resolve, 25))
      if (this.restricted) throw new Error('bridge_reply_platform_restricted')
      if (!this.self || !this.room) throw new Error('bridge_reply_identity_unavailable')
    })().catch(error => {
      this.refreshFailure = error instanceof Error ? error.message : 'bridge_reply_refresh_failed'
      // Late responses from the failed refresh cannot restore apparently valid identity.
      this.generations.self++
      this.generations.room++
      this.self = null
      this.room = null
      throw error
    }).finally(() => { this.pending = null })
    return this.pending
  }

  async inspect(includeControls = false) {
    const room = this.room?.value
    // Routine health/preflight must remain readable even when a renderer is stuck.
    const controls = includeControls ? await this.roomPage?.evaluate(() => ({
      inputs: [...document.querySelectorAll('textarea,[contenteditable="true"]')].map(x => ({
        tag: x.tagName, id: x.id, className: x.className, placeholder: x.getAttribute('placeholder'),
        dataE2e: x.getAttribute('data-e2e'), role: x.getAttribute('role') })),
      submit: [...document.querySelectorAll('button,[role="button"]')]
        .filter(x => x.textContent?.trim() === '发送').map(x => ({ tag: x.tagName, id: x.id,
          className: x.className, dataE2e: x.getAttribute('data-e2e') })),
    })).catch(() => null) : null
    if (this.ownedPid) await ownedBrowserWindows(this.ownedPid, this.config.profileDir, false)
    return { transport: this.ownedPid ? 'hidden_owned_browser' : 'headless_browser', desktopVisible: false, roomUrl: this.url,
      loggedIn: this.self?.id === this.config.expectedExecutorId,
      ownerMatches: room?.ownerId === this.config.expectedOwnerId,
      live: room?.live ?? false, roomId: room?.live ? room.roomId : null,
      ownerId: room?.ownerId ?? null,
      adminObserved: !!room?.adminIds.includes(this.config.expectedExecutorId),
      restricted: this.restricted,
      selectorsConfigured: !!this.config.inputSelector && !!this.config.submitSelector,
      observedAt: this.room ? new Date(this.room.at).toISOString() : null,
      refreshFailure: this.refreshFailure, diagnostic: this.roomDiagnostic, controls }
  }

  async snapshot(signal?: AbortSignal): Promise<ReplySnapshot> {
    if (this.ownedPid) await ownedBrowserWindows(this.ownedPid, this.config.profileDir, false)
    if (signal?.aborted) throw new Error('room_request_cancelled')
    if (!this.self || !this.room || Date.now() - Math.min(this.self.at, this.room.at) > 20_000) await this.refresh()
    const page = this.roomPage
    if (signal?.aborted || !page || page.isClosed() || page.url().split('?')[0] !== this.url
      || !this.self || !this.room) throw new Error('room_identity_unavailable')
    // A visible platform verification challenge is a stop condition, never an instruction to solve it.
    const challenge = await page.locator('iframe[src*="captcha"]:visible,iframe[src*="verifycenter"]:visible,[id*="captcha"]:visible').count()
    if (challenge) this.restricted = true
    let canSend = false
    if (this.config.inputSelector && this.config.submitSelector) {
      const input = page.locator(this.config.inputSelector)
      const submit = page.locator(this.config.submitSelector)
      canSend = await input.count() === 1 && await submit.count() === 1
        && await input.isVisible() && await input.isEditable() && await submit.isVisible()
    }
    return { ownerId: this.room.value.ownerId, roomId: this.room.value.roomId,
      executorId: this.self.id, live: this.room.value.live,
      admin: this.room.value.adminIds.includes(this.self.id), canSend, blocked: this.restricted,
      observedAt: Math.min(this.self.at, this.room.at),
      generation: createHash('sha256').update(JSON.stringify([this.generations, this.self.id, this.room.value])).digest('hex') }
  }

  async submit(text: string, beforeSubmit: () => Promise<void>, signal?: AbortSignal) {
    const page = this.roomPage
    if (!page || !this.config.inputSelector || !this.config.submitSelector) throw new Error('room_controls_unconfigured')
    const input = page.locator(this.config.inputSelector)
    await input.fill(text, { timeout: 1000 })
    await beforeSubmit()
    if (signal?.aborted) throw new Error('room_request_cancelled')
    // One attempt, no Enter fallback and no retry. Click is never reported as delivery confirmation.
    await page.evaluate(({ inputSelector, submitSelector, expectedText, expectedUrl }) => {
      if (location.origin + location.pathname !== expectedUrl) throw new Error('room_context_changed')
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(inputSelector)
      const buttons = document.querySelectorAll<Element>(submitSelector)
      if (inputs.length !== 1 || buttons.length !== 1) throw new Error('room_controls_changed')
      const input = inputs[0], button = buttons[0]
      const value = 'value' in input ? input.value : input.textContent
      if (value !== expectedText || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'
        || button.getClientRects().length === 0 || input.getClientRects().length === 0) throw new Error('room_submit_unavailable')
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }, { inputSelector: this.config.inputSelector, submitSelector: this.config.submitSelector, expectedText: text, expectedUrl: this.url })
    return { status: 'uncertain' as const, evidenceKind: 'click_only' as const,
      evidenceRef: null, observedAt: new Date().toISOString(), errorCode: 'room_delivery_unconfirmed' }
  }

  async stop(): Promise<void> {
    // A manually authenticated attached browser stays alive for diagnosis/reconnection.
    if (!this.attachedBrowser) await this.context?.close()
    this.context = null
  }
}
