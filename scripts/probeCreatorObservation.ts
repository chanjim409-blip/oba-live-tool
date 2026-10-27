import type { LiveTap } from '../electron/main/bridge/liveTap'

type Context = ReturnType<LiveTap['replyContext']>
export type CandidateControls = { inputCount: number; inputVisible: boolean; inputEditable: boolean;
  submitCount: number; submitVisible: boolean; submitDisabled: boolean | null }

/** This is evidence collection, not a role or permission check. Never navigate, reload, or submit. */
export async function collectStableCreatorEvidence(tap: Pick<LiveTap, 'identityProbeSummary' | 'replyContext'>, options: {
  timeoutMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; checkPlatformGate?: () => Promise<void>
} = {}): Promise<{ context: Context; candidateControls: CandidateControls }> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (options.timeoutMs ?? 15_000)
  let previousReason = 'identity_response_not_observed'
  const usableContext = async (): Promise<Context | null> => {
    await options.checkPlatformGate?.()
    const summary = await tap.identityProbeSummary()
    if (summary.restricted) throw new Error('platform_verification_required')
    try {
      const current = tap.replyContext()
      if (!current.loggedIn || !current.facts || !current.identityData) return null
      const age = now() - Date.parse(current.facts.observedAt)
      if (!Number.isFinite(age) || age < 0 || age > 30_000) { previousReason = 'identity_observation_expired'; return null }
      return current
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === 'buyin_page_changed' || message === 'buyin_background_page_unavailable') {
        previousReason = message
        return null
      }
      // A platform stop or any unexpected error is never treated as a reason to retry.
      throw error
    }
  }
  const unchanged = (a: Context, b: Context | null) => !!b && a.page === b.page && a.generation === b.generation
    && a.facts === b.facts && a.identityData === b.identityData && a.roomId === b.roomId

  while (now() < deadline) {
    const before = await usableContext()
    if (!before) { await sleep(Math.min(200, Math.max(0, deadline - now()))); continue }
    // Poll within this loaded page only; do not trigger a new platform navigation or identity request.
    await before.page.locator('#input-comment-block-id textarea:visible').first()
      .waitFor({ state: 'visible', timeout: Math.max(1, Math.min(1000, deadline - now())) }).catch(() => {})
    const ready = await usableContext()
    if (!unchanged(before, ready)) { previousReason = 'buyin_context_changed'; continue }
    let candidateControls: CandidateControls
    try {
      candidateControls = await before.page.evaluate(() => {
        // Upstream's exact candidates; selectors alone do not prove execution permission.
        const inputs = document.querySelectorAll<HTMLTextAreaElement>('#input-comment-block-id textarea')
        const buttons = document.querySelectorAll<HTMLElement>('#input-comment-block-id div[class^="inputSuffix"]')
        const visible = (element: HTMLElement) => {
          const style = getComputedStyle(element)
          return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        }
        const input = inputs.length === 1 ? inputs[0] : null
        const button = buttons.length === 1 ? buttons[0] : null
        return { inputCount: inputs.length, inputVisible: !!input && visible(input),
          inputEditable: !!input && visible(input) && !input.matches(':disabled') && !input.readOnly && input.getAttribute('aria-disabled') !== 'true',
          submitCount: buttons.length, submitVisible: !!button && visible(button),
          submitDisabled: button ? button.className.includes('isDisabled') || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' : null }
      })
    } catch (error) {
      // React navigation can destroy an evaluation context. Retry only after seeing a changed
      // generation/page; an unchanged context failure is never treated as permission to retry.
      if (!unchanged(before, await usableContext())) { previousReason = 'buyin_context_changed'; continue }
      throw error
    }
    const after = await usableContext()
    if (!unchanged(before, after)) { previousReason = 'buyin_context_changed'; continue }
    // Current room is evidence only while its observation is fresh. An old room remains unknown.
    const roomAge = now() - before.roomObservedAt
    const context = before.roomId && (!Number.isFinite(roomAge) || roomAge < 0 || roomAge > 30_000)
      ? { ...before, roomId: null } : before
    return { context, candidateControls }
  }
  throw new Error(previousReason)
}
