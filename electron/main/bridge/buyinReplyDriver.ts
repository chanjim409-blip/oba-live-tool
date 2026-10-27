import { createHash } from 'node:crypto'
import type { LiveTap } from './liveTap'
import type { BackgroundReplyDriver, ReplySnapshot } from './backgroundReplySource'

export interface BuyinReplyConfig {
  expectedOwnerId: string
  expectedExecutorId: string
  inputSelector: string
  submitSelector: string
  /** Explicit mapping from inspected getUser data; absent until the real role field is verified.
   * Never configure this from the displayed creator nickname or a synthetic response. */
  creatorRoleEvidence?: { path: string[]; value: boolean | string | number }
}

export function matchesCreatorEvidence(data: unknown, rule: BuyinReplyConfig['creatorRoleEvidence']): boolean {
  if (!rule || !rule.path.length || rule.path.length > 8) return false
  let current: unknown = data
  for (const key of rule.path) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !current || typeof current !== 'object'
      || !Object.hasOwn(current, key)) return false
    current = (current as Record<string, unknown>)[key]
  }
  return current !== null && current !== undefined && current === rule.value
}

/** Own collector page only. No endpoint guessing, browser attachment or automatic resend. */
export class BuyinReplyDriver implements BackgroundReplyDriver {
  private blocked = false
  constructor(private readonly tap: LiveTap, private readonly config: BuyinReplyConfig) {
    if (!config.expectedOwnerId || !config.expectedExecutorId || !config.inputSelector || !config.submitSelector)
      throw new Error('buyin_reply_configuration_invalid')
  }
  async snapshot(signal?: AbortSignal): Promise<ReplySnapshot> {
    if (signal?.aborted || this.blocked) throw new Error('buyin_reply_blocked')
    const pinned = this.tap.replyContext()
    if (!pinned.loggedIn) throw new Error('buyin_login_unavailable')
    if (await pinned.page.locator('iframe[src*="captcha"]:visible,iframe[src*="verifycenter"]:visible,[id*="captcha"]:visible').count()) {
      this.blocked = true
      throw new Error('host_platform_restricted')
    }
    await this.tap.refreshReplyEvidence()
    const seen = this.tap.replyContext()
    if (signal?.aborted || pinned.page !== seen.page || pinned.generation !== seen.generation || !seen.loggedIn || !seen.facts)
      throw new Error('buyin_identity_unavailable')
    const input = seen.page.locator(this.config.inputSelector)
    const submit = seen.page.locator(this.config.submitSelector)
    const canSend = await input.count() === 1 && await submit.count() === 1
      && await input.isVisible() && await input.isEditable() && await submit.isVisible()
    const current = this.tap.replyContext()
    if (signal?.aborted || current.generation !== seen.generation || current.facts !== seen.facts) throw new Error('buyin_context_changed')
    return { ownerId: seen.facts.userId ?? '', executorId: seen.facts.buyinAccountId ?? '', roomId: seen.roomId ?? '',
      live: !!seen.roomId, admin: false, creator: matchesCreatorEvidence(seen.identityData, this.config.creatorRoleEvidence),
      canSend, blocked: this.blocked, observedAt: Math.min(Date.parse(seen.facts.observedAt), seen.roomObservedAt),
      generation: createHash('sha256').update(JSON.stringify([seen.generation, seen.facts.userId,
        seen.facts.buyinAccountId, seen.facts.originUid, seen.facts.drAuth, seen.roomId, matchesCreatorEvidence(seen.identityData, this.config.creatorRoleEvidence)])).digest('hex') }
  }
  async submit(text: string, beforeSubmit: () => Promise<void>, signal?: AbortSignal) {
    const pinned = this.tap.replyContext()
    await pinned.page.locator(this.config.inputSelector).fill(text, { timeout: 1000 })
    // Inspect before claiming; claim exactly once as close to the irreversible click as possible.
    const seen = await this.snapshot(signal)
    const current = this.tap.replyContext()
    if (signal?.aborted || !seen.creator || !seen.canSend || seen.ownerId !== this.config.expectedOwnerId
      || seen.executorId !== this.config.expectedExecutorId || current.page !== pinned.page
      || current.generation !== pinned.generation || current.roomId !== pinned.roomId) throw new Error('buyin_context_changed')
    await beforeSubmit()
    const finalContext = this.tap.replyContext()
    if (signal?.aborted || finalContext.page !== pinned.page || finalContext.generation !== pinned.generation
      || finalContext.roomId !== pinned.roomId) throw new Error('buyin_context_changed')
    await pinned.page.evaluate(({ inputSelector, submitSelector, expectedText }) => {
      if (location.origin !== 'https://buyin.jinritemai.com' || location.pathname !== '/dashboard/live/control') throw new Error('buyin_page_changed')
      if ([...document.querySelectorAll<HTMLElement>('iframe[src*="captcha"],iframe[src*="verifycenter"],[id*="captcha"]')].some(el => el.getClientRects().length > 0)) throw new Error('host_platform_restricted')
      const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(inputSelector)
      const buttons = document.querySelectorAll<HTMLElement>(submitSelector)
      if (inputs.length !== 1 || buttons.length !== 1 || inputs[0].value !== expectedText
        || !inputs[0].getClientRects().length || !buttons[0].getClientRects().length
        || buttons[0].hasAttribute('disabled') || buttons[0].getAttribute('aria-disabled') === 'true') throw new Error('buyin_controls_changed')
      buttons[0].click()
    }, { inputSelector: this.config.inputSelector, submitSelector: this.config.submitSelector, expectedText: text })
    return { status: 'uncertain' as const, evidenceKind: 'click_only' as const, evidenceRef: null,
      observedAt: new Date().toISOString(), errorCode: 'host_delivery_unknown' }
  }
}
