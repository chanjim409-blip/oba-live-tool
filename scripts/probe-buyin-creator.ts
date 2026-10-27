/** Read-only real-page preparation; never calls submit or persists browser storage. */
import { writeFileSync } from 'node:fs'
import { LiveTap } from '../electron/main/bridge/liveTap'

const storageStatePath = process.env.LIVE_ASSISTANT_LOGIN_STATE
const output = process.env.LIVE_ASSISTANT_IDENTITY_PROBE_OUTPUT
if (!storageStatePath || !output) throw new Error('private_input_and_output_required')
const tap = new LiveTap({ storageStatePath, executablePath: process.env.TEST_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, identityOnly: true, log: () => {} })
try {
  await tap.start()
  if (!tap.loggedIn) {
    writeFileSync(output, JSON.stringify({ ok: false, observedAt: new Date().toISOString(), reason: 'login_required' }), { mode: 0o600 })
    console.log(JSON.stringify({ loggedIn: false, requiresHumanLogin: true })); process.exitCode = 2
  }
  else {
    const before = await tap.identityProbeSummary()
    if (before.restricted) throw new Error('platform_verification_required')
    const deadline = Date.now() + 12_000
    while (!tap.facts && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
    if (!tap.facts) {
      const summary = await tap.identityProbeSummary()
      if (summary.restricted) throw new Error('platform_verification_required')
      writeFileSync(output, JSON.stringify({ ok: false, observedAt: new Date().toISOString(), reason: 'identity_response_not_observed', summary }), { mode: 0o600 })
      console.log(JSON.stringify({ ok: false, reason: 'identity_response_not_observed', summary }))
      process.exitCode = 2
      process.exitCode && await tap.stop()
      process.exit(process.exitCode)
    }
    // Inspect the first page-observed response before making any further request: a creator
    // may not have the subaccount fields that refreshIdentity currently requires.
    const context = tap.replyContext()
    if (!context.facts || !context.identityData) throw new Error('identity_response_not_observed')
    const challenge = await context.page.locator('iframe[src*="captcha"]:visible,iframe[src*="verifycenter"]:visible,[id*="captcha"]:visible').count()
    if (challenge) throw new Error('platform_verification_required')
    const fields: Record<string, string> = {}, roleValues: Record<string, unknown> = {}
    const walk = (value: unknown, path: string[] = []) => {
      if (path.length > 5 || !value || typeof value !== 'object' || Array.isArray(value)) return
      for (const [key, item] of Object.entries(value)) {
        const next = [...path, key], name = next.join('.')
        fields[name] = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item
        if (/role|account_type|is_sub|is_main|authority|identity_type/.test(key)
          && (typeof item === 'boolean' || typeof item === 'number' && Math.abs(item) < 100 || typeof item === 'string' && ['owner', 'creator', 'main', 'sub', '达人', '主账号', '子账号'].includes(item))) roleValues[name] = item
        walk(item, next)
      }
    }
    walk(context.identityData)
    await context.page.locator('textarea, input, [contenteditable="true"]').first()
      .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    const afterRender = await tap.identityProbeSummary()
    if (afterRender.restricted) throw new Error('platform_verification_required')
    if (tap.replyContext().generation !== context.generation) throw new Error('buyin_context_changed')
    const controls = await context.page.evaluate(() => [...document.querySelectorAll('textarea,input,[contenteditable="true"]')]
      .filter(el => el.getClientRects().length > 0).map(el => ({ tag: el.tagName, id: el.id,
        className: el.className, parentId: el.parentElement?.id, parentClass: el.parentElement?.className,
        type: el.getAttribute('type'), placeholder: el.getAttribute('placeholder') })))
    const buttons = await context.page.evaluate(() => [...document.querySelectorAll('button,[role="button"]')]
      .filter(el => el.getClientRects().length > 0 && (el.textContent ?? '').trim() === '发布')
      .map(el => ({ tag: el.tagName, id: el.id, className: el.className, parentId: el.parentElement?.id,
        parentClass: el.parentElement?.className, disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' })))
    // Private evidence contains stable IDs, never credentials, chat, catalog or raw platform response.
    writeFileSync(output, JSON.stringify({ observedAt: new Date().toISOString(), facts: context.facts,
      fields, roleValues, controls, buttons, roomId: context.roomId }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ loggedIn: context.loggedIn, fields, roleValues, controls, buttons, privateEvidenceSaved: true }))
  }
} catch (error) {
  writeFileSync(output, JSON.stringify({ ok: false, observedAt: new Date().toISOString(), reason: 'probe_failed' }), { mode: 0o600 })
  console.log(JSON.stringify({ ok: false, reason: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'probe_failed' }))
  process.exitCode = 2
} finally { await tap.stop() }
