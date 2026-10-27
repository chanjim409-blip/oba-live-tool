import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { lstatSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { join, resolve, isAbsolute, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** A stop is NOT evidence of a current platform violation: it means manual review is pending. */
interface StopSnapshot {
  version: 1
  source: 'legacy_reply_preflight'
  restricted: true
  manualState: 'manual' | 'blocked'
  capturedAt: string
  observedAt: string | null
  port: number
  signature: string
}

/** Paths must resolve strictly below the trusted private root, including on Windows. */
export function insidePrivateRoot(root: string, path: string, api: { relative: typeof relative; isAbsolute: typeof isAbsolute; sep: string } = { relative, isAbsolute, sep }): boolean {
  const rel = api.relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel)
}

function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
}
function canonical(value: Omit<StopSnapshot, 'signature'>) {
  return JSON.stringify([value.version, value.source, value.restricted, value.manualState, value.capturedAt, value.observedAt, value.port])
}
function sign(value: Omit<StopSnapshot, 'signature'>, key: string) {
  return createHmac('sha256', key).update(canonical(value)).digest('hex')
}
function requireKey(key: string) { if (key.length < 32 || /[\r\n]/.test(key)) throw new Error('migration_key_invalid') }

export function snapshotFromPreflight(raw: unknown, key: string, capturedAt: string, port = 9310): StopSnapshot {
  requireKey(key)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('migration_evidence_invalid')
  const state = raw as Record<string, unknown>
  if (state.restricted !== true || (state.manualState !== 'manual' && state.manualState !== 'blocked')
    || !iso(capturedAt) || !(state.observedAt === null || iso(state.observedAt))
    || (typeof state.observedAt === 'string' && Date.parse(state.observedAt) > Date.parse(capturedAt) + 30_000)
    || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('migration_evidence_invalid')
  const snapshot: Omit<StopSnapshot, 'signature'> = { version: 1, source: 'legacy_reply_preflight', restricted: true,
    manualState: state.manualState, capturedAt, observedAt: state.observedAt as string | null, port }
  return { ...snapshot, signature: sign(snapshot, key) }
}

export function verifySnapshot(raw: unknown, key: string, expectedPort = 9310, now = Date.now()): StopSnapshot {
  requireKey(key)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('migration_evidence_invalid')
  const v = raw as Record<string, unknown>
  const keys = ['capturedAt', 'manualState', 'observedAt', 'port', 'restricted', 'signature', 'source', 'version']
  if (Object.keys(v).sort().join('|') !== keys.sort().join('|') || v.version !== 1 || v.source !== 'legacy_reply_preflight'
    || v.restricted !== true || (v.manualState !== 'manual' && v.manualState !== 'blocked') || !iso(v.capturedAt)
    || Date.parse(v.capturedAt) > now + 30_000 || !(v.observedAt === null || iso(v.observedAt))
    || (typeof v.observedAt === 'string' && Date.parse(v.observedAt) > Date.parse(v.capturedAt) + 30_000)
    || v.port !== expectedPort || typeof v.signature !== 'string' || !/^[a-f0-9]{64}$/.test(v.signature)) throw new Error('migration_evidence_invalid')
  const value = v as unknown as StopSnapshot
  const expected = Buffer.from(sign(value, key), 'hex')
  if (!timingSafeEqual(expected, Buffer.from(value.signature, 'hex'))) throw new Error('migration_evidence_invalid')
  return value
}

/** Input must be an authenticated loopback-only cached preflight. Never fetch or refresh platform. */
export async function captureCachedPreflight(key: string, outputFile: string, request: typeof fetch = fetch): Promise<void> {
  requireKey(key)
  if (!isAbsolute(outputFile)) throw new Error('migration_path_invalid')
  const response = await request('http://127.0.0.1:9310/reply/preflight', { headers: { authorization: `Bearer ${key}` },
    redirect: 'error', signal: AbortSignal.timeout(4000) })
  if (!response.ok) throw new Error('migration_preflight_unavailable')
  if (!response.body) throw new Error('migration_preflight_unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > 16_384) { await reader.cancel(); throw new Error('migration_preflight_unavailable') }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const snapshot = snapshotFromPreflight(JSON.parse(Buffer.concat(chunks).toString('utf8')), key, new Date().toISOString())
  // Never replace an existing capture; a missing or stale capture remains an operator decision.
  const fd = openSync(outputFile, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(snapshot)); fsyncSync(fd) } finally { closeSync(fd) }
}

async function reserveLegacyPort(port: number): Promise<Server> {
  const listener = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen({ host: '127.0.0.1', port, exclusive: true }, () => { listener.removeListener('error', reject); resolve() })
  }).catch(() => { throw new Error('migration_legacy_port_busy') })
  return listener
}

/** On Windows any observed bridge or generic Electron process makes ownership unknown. */
async function requireNoBridgeProcesses(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('migration_process_check_unavailable')
  const script = String.raw`$ErrorActionPreference='Stop'
$null=Get-Command Get-NetTCPConnection -ErrorAction Stop
$listeners=@(Get-NetTCPConnection -LocalPort 9310 -State Listen -ErrorAction Stop)
$own=$false
foreach($connection in $listeners){if($connection.OwningProcess -ne [int]$env:LA_MIGRATION_PID){throw 'busy'}; $own=$true}
if(-not $own){throw 'unknown'}
$ps=Get-CimInstance Win32_Process
foreach($p in $ps){
 if($p.ProcessId -eq [int]$env:LA_MIGRATION_PID){continue}
 if($p.Name -match '(?i)^(electron|oba-live-tool|live-assistant)(\.exe)?$'){throw 'busy'}
 if($p.Name -eq 'node.exe'){
   if($null -eq $p.CommandLine){throw 'unknown'}
   if($p.CommandLine -match '(?i)bridge-server\.ts'){throw 'busy'}
 }
}`
  try { await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 8000, windowsHide: true, env: { ...process.env, LA_MIGRATION_PID: String(process.pid) },
  }) } catch { throw new Error('migration_process_check_failed') }
}

/** Require no existing file handles before taking the SQLite write transaction. */
export async function requireDatabaseUnopened(dbPath: string): Promise<void> {
  if (process.platform !== 'win32' || !isAbsolute(dbPath)) throw new Error('migration_database_check_unavailable')
  const script = String.raw`$ErrorActionPreference='Stop'
$handles=@()
try {
  foreach($p in @($env:LA_MIGRATION_DB,($env:LA_MIGRATION_DB+'-wal'),($env:LA_MIGRATION_DB+'-shm'))){
    if(Test-Path -LiteralPath $p){
      $item=Get-Item -LiteralPath $p -Force
      if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'invalid'}
      $handles += [IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
  }
} finally {foreach($handle in $handles){$handle.Dispose()}}`
  try { await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 8000, windowsHide: true, env: { ...process.env, LA_MIGRATION_DB: dbPath },
  }) } catch { throw new Error('migration_database_in_use') }
}

export interface MigrationDependencies {
  reserve?: (port: number) => Promise<{ close(cb: (error?: Error) => void): unknown }>
  checkProcesses?: () => Promise<void>
  checkDatabase?: (path: string) => Promise<void>
  now?: () => number
}

/** Preserve the stop even when migration fails; never clear an existing stop or open a browser. */
export async function migrateLegacyStop(snapshotFile: string, dataDir: string, key: string, deps: MigrationDependencies = {}): Promise<void> {
  if (!isAbsolute(snapshotFile) || !isAbsolute(dataDir)) throw new Error('migration_path_invalid')
  const target = resolve(dataDir)
  const dbPath = join(target, 'host-identity.sqlite')
  const listener = await (deps.reserve ?? reserveLegacyPort)(9310)
  let db: DatabaseSync | null = null
  const marker = join(target, 'buyin-restriction-storage-fault.lock')
  const markerContent = `manual-review-required ${randomUUID()}\n`
  let markerOwned = false
  try {
    // The current host refuses to start while this marker exists. Create it before touching DB.
    const fd = openSync(marker, 'wx', 0o600)
    markerOwned = true
    try { writeFileSync(fd, markerContent); fsyncSync(fd) } finally { closeSync(fd) }
    await (deps.checkProcesses ?? requireNoBridgeProcesses)()
    const snapshotInfo = lstatSync(snapshotFile)
    if (!snapshotInfo.isFile() || snapshotInfo.isSymbolicLink() || snapshotInfo.size > 4096) throw new Error('migration_evidence_invalid')
    const snapshot = verifySnapshot(JSON.parse(readFileSync(snapshotFile, 'utf8')), key, 9310, deps.now?.() ?? Date.now())
    const dbInfo = lstatSync(dbPath)
    if (!dbInfo.isFile() || dbInfo.isSymbolicLink()) throw new Error('migration_database_invalid')
    await (deps.checkDatabase ?? requireDatabaseUnopened)(dbPath)
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE')
    try {
      db.exec('CREATE TABLE IF NOT EXISTS buyin_restriction_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), code TEXT NOT NULL, observed_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS buyin_restriction_history (at TEXT NOT NULL, event TEXT NOT NULL, code TEXT NOT NULL)')
      const existing = db.prepare('SELECT code FROM buyin_restriction_state WHERE singleton=1').get() as { code?: unknown } | undefined
      const codes = ['host_login_expired', 'host_permission_denied', 'host_rate_limited', 'host_platform_restricted']
      if (existing && (typeof existing.code !== 'string' || !codes.includes(existing.code))) throw new Error('migration_database_invalid')
      if (!existing) {
        db.prepare('INSERT INTO buyin_restriction_state(singleton,code,observed_at) VALUES(1,?,?)').run('host_platform_restricted', snapshot.capturedAt)
        db.prepare('INSERT INTO buyin_restriction_history(at,event,code) VALUES(?,?,?)').run(new Date(deps.now?.() ?? Date.now()).toISOString(), 'legacy_stop_migrated', 'host_platform_restricted')
      }
      await (deps.checkProcesses ?? requireNoBridgeProcesses)()
      db.exec('COMMIT')
    } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
    const row = db.prepare('SELECT code FROM buyin_restriction_state WHERE singleton=1').get() as { code?: string } | undefined
    if (!row?.code) throw new Error('migration_stop_unverified')
    db.close(); db = null
    // Only delete the marker we just created, after the saved stop was re-read successfully.
    if (markerOwned) {
      const info = lstatSync(marker)
      if (!info.isFile() || info.isSymbolicLink() || readFileSync(marker, 'utf8') !== markerContent) throw new Error('migration_marker_changed')
      unlinkSync(marker); markerOwned = false
    }
  } catch {
    // A created marker remains on any failure, so startup stays blocked for manual review.
    throw new Error('migration_failed_review_required')
  } finally {
    try { db?.close() } catch {}
    await new Promise<void>(resolveDone => listener.close(() => resolveDone()))
  }
}
