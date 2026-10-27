/** Manual operator tool: capture cached legacy stop, then migrate only after legacy host has exited.
 * No browser, platform request, service start, process termination, or stop clearing is performed. */
import { readFileSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { captureCachedPreflight, migrateLegacyStop, insidePrivateRoot } from '../electron/main/bridge/legacyStopMigration'

const manifestFile = 'D:/live-assistant/shared-paths.json'
try {
  if (process.platform !== 'win32' || process.argv.length !== 3 || !['capture', 'migrate'].includes(process.argv[2])) throw new Error('migration_usage_invalid')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { privateRoot?: string; bridgeData?: string; credentials?: { bridgeToken?: string } }
  if (!manifest.privateRoot || !manifest.bridgeData || !manifest.credentials?.bridgeToken) throw new Error('migration_config_invalid')
  const root = realpathSync(resolve(manifest.privateRoot)), dataDir = realpathSync(resolve(manifest.bridgeData))
  const tokenFile = realpathSync(resolve(manifest.credentials.bridgeToken))
  if (!insidePrivateRoot(root, dataDir) || !insidePrivateRoot(root, tokenFile) || !lstatSync(tokenFile).isFile()) throw new Error('migration_config_invalid')
  const key = readFileSync(tokenFile, 'utf8').trim()
  const snapshot = join(dataDir, 'legacy-manual-stop-snapshot.json')
  if (process.argv[2] === 'capture') await captureCachedPreflight(key, snapshot)
  else await migrateLegacyStop(snapshot, dataDir, key)
  console.log(process.argv[2] === 'capture' ? 'legacy_stop_snapshot_saved' : 'legacy_stop_migrated_pending_manual_review')
} catch (error) {
  const allowed = ['migration_usage_invalid', 'migration_config_invalid', 'migration_key_invalid', 'migration_evidence_invalid',
    'migration_preflight_unavailable', 'migration_legacy_port_busy', 'migration_process_check_failed', 'migration_failed_review_required']
  console.error(error instanceof Error && allowed.includes(error.message) ? error.message : 'migration_failed_review_required')
  process.exitCode = 1
}
