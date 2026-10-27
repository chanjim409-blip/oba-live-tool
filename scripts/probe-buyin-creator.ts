/** Read-only real-page preparation; never calls submit or persists browser storage. */
import { writeFileSync } from 'node:fs'
import { LiveTap } from '../electron/main/bridge/liveTap'
import { collectStableCreatorEvidence } from './probeCreatorObservation'
import { ProbeRestrictionClient } from './probeRestrictionClient'

const storageStatePath = process.env.LIVE_ASSISTANT_LOGIN_STATE
const output = process.env.LIVE_ASSISTANT_IDENTITY_PROBE_OUTPUT
if (!storageStatePath || !output) throw new Error('private_input_and_output_required')
const tap = new LiveTap({ storageStatePath, executablePath: process.env.TEST_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, identityOnly: true, log: () => {} })
let gate: ProbeRestrictionClient | null = null
try {
  // The running host owns the only writable restriction database. An old/unavailable host
  // cannot establish that there is no durable stop, so never start a browser in that case.
  gate = new ProbeRestrictionClient(process.env.LIVE_ASSISTANT_BRIDGE_TOKEN ?? '', Number(process.env.LIVE_ASSISTANT_BRIDGE_PORT ?? '9310'))
  await gate.assertAllowed()
  await tap.start()
  {
    // Wait for a stable observation after SPA navigation, without reloading or requesting
    // an identity endpoint. The helper discards evidence whenever page/account/room changes.
    const { context, candidateControls } = await collectStableCreatorEvidence(tap, { checkPlatformGate: () => gate!.assertAllowed() })
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
    // Private evidence contains stable IDs, never credentials, chat, catalog or raw platform response.
    writeFileSync(output, JSON.stringify({ observedAt: new Date().toISOString(), facts: context.facts,
      fields, roleValues, candidateControls, roomId: context.roomId }, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({ loggedIn: context.loggedIn, fields, roleValues, candidateControls, privateEvidenceSaved: true }))
  }
} catch (error) {
  let reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'probe_failed'
  // A restriction seen by this separate browser must be persisted by the host before the
  // operator can resume any work. Reporting failure remains visible and never retried.
  if (tap.restrictionCode) {
    try { if (!gate) throw new Error('host_restriction_gate_unavailable'); await gate.report(tap.restrictionCode) }
    catch { reason = 'host_restriction_report_failed' }
  }
  writeFileSync(output, JSON.stringify({ ok: false, observedAt: new Date().toISOString(), reason }), { mode: 0o600 })
  console.log(JSON.stringify({ ok: false, reason }))
  process.exitCode = 2
} finally { await tap.stop() }
