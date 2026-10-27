import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { snapshotFromPreflight, verifySnapshot, migrateLegacyStop, insidePrivateRoot, captureCachedPreflight, requireDatabaseUnopened } from './legacyStopMigration'

const key = 'synthetic-token-'.repeat(4)
const at = '2026-10-27T07:12:10.000Z'
const now = Date.parse('2026-10-27T15:00:00.000Z')

test('Windows private root blocks parent traversal, root itself, siblings and other drives', () => {
  const root = 'D:\\live-assistant\\private'
  assert.equal(insidePrivateRoot(root, 'D:\\live-assistant\\private\\bridge-data', win32), true)
  assert.equal(insidePrivateRoot(root, root, win32), false)
  assert.equal(insidePrivateRoot(root, 'D:\\live-assistant\\private-sibling\\secret', win32), false)
  assert.equal(insidePrivateRoot(root, 'D:\\live-assistant\\private\\..\\outside', win32), false)
  assert.equal(insidePrivateRoot(root, 'C:\\outside\\secret', win32), false)
})

test('Windows database ownership probe rejects an already open SQLite connection', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture()
  try {
    await requireDatabaseUnopened(f.dbPath)
    const db = new DatabaseSync(f.dbPath)
    try { await assert.rejects(requireDatabaseUnopened(f.dbPath), /migration_database_in_use/) }
    finally { db.close() }
    await requireDatabaseUnopened(f.dbPath)
  } finally { f.close() }
})

test('local cached preflight capture is bounded, redacted and never overwrites', async () => {
  const f = fixture()
  try {
    const output = join(f.dir, 'capture.json')
    const fake: typeof fetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:9310/reply/preflight')
      assert.equal(init?.redirect, 'error')
      return new Response(JSON.stringify({ restricted: true, manualState: 'manual', observedAt: at,
        accountId: 'synthetic-id', cookie: 'synthetic-secret' }))
    }
    await captureCachedPreflight(key, output, fake)
    const saved = readFileSync(output, 'utf8')
    assert.doesNotMatch(saved, /synthetic-id|synthetic-secret/)
    assert.equal(verifySnapshot(JSON.parse(saved), key).restricted, true)
    await assert.rejects(captureCachedPreflight(key, output, fake))
    assert.equal(readFileSync(output, 'utf8'), saved)
    const oversized = join(f.dir, 'oversized.json')
    await assert.rejects(captureCachedPreflight(key, oversized, async () => new Response('x'.repeat(20_000))), /preflight_unavailable/)
    assert.equal(existsSync(oversized), false)
  } finally { f.close() }
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-stop-test-'))
  const dbPath = join(dir, 'host-identity.sqlite'), snapshotPath = join(dir, 'legacy-stop.json')
  new DatabaseSync(dbPath).close()
  const snapshot = snapshotFromPreflight({ restricted: true, manualState: 'manual', observedAt: at,
    ignoredSyntheticSecret: 'must-not-be-copied' }, key, new Date(now).toISOString())
  writeFileSync(snapshotPath, JSON.stringify(snapshot))
  let reservations = 0, releases = 0, processChecks = 0
  const deps = { now: () => now, reserve: async () => { reservations++; return { close: (cb: () => void) => { releases++; cb() } } },
    checkProcesses: async () => { processChecks++ }, checkDatabase: async () => {} }
  return { dir, dbPath, snapshotPath, snapshot, deps, reservations: () => reservations, releases: () => releases,
    processChecks: () => processChecks, close: () => {
      const resolved = realpathSync(dir)
      if (dirname(resolved) !== realpathSync(tmpdir()) || !basename(resolved).startsWith('legacy-stop-test-')) throw new Error('test_cleanup_path_invalid')
      rmSync(resolved, { recursive: true, force: true })
    } }
}

test('only signed restricted manual snapshots can be migrated; no page or identity data is retained', () => {
  const f = fixture()
  try {
    assert.equal(verifySnapshot(f.snapshot, key, 9310, now).restricted, true)
    assert.doesNotMatch(JSON.stringify(f.snapshot), /must-not-be-copied/)
    assert.throws(() => verifySnapshot({ ...f.snapshot, restricted: false }, key, 9310, now), /evidence_invalid/)
    assert.throws(() => verifySnapshot({ ...f.snapshot, manualState: 'blocked' }, key, 9310, now), /evidence_invalid/)
    assert.throws(() => verifySnapshot({ ...f.snapshot, extra: 'not-allowed' }, key, 9310, now), /evidence_invalid/)
    assert.throws(() => verifySnapshot(f.snapshot, 'other-synthetic-token-'.repeat(3), 9310, now), /evidence_invalid/)
    assert.throws(() => snapshotFromPreflight({ restricted: false, manualState: 'manual', observedAt: at }, key, at), /evidence_invalid/)
    assert.throws(() => snapshotFromPreflight({ restricted: true, manualState: 'none', observedAt: at }, key, at), /evidence_invalid/)
  } finally { f.close() }
})

test('migration writes a persistent stop exactly once and releases its reservation', async () => {
  const f = fixture()
  try {
    await migrateLegacyStop(f.snapshotPath, f.dir, key, f.deps)
    await migrateLegacyStop(f.snapshotPath, f.dir, key, f.deps)
    const db = new DatabaseSync(f.dbPath)
    try {
      assert.equal((db.prepare('SELECT code FROM buyin_restriction_state WHERE singleton=1').get() as {code: string}).code, 'host_platform_restricted')
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM buyin_restriction_history').get() as {n: number}).n, 1)
    } finally { db.close() }
    assert.equal(f.reservations(), 2); assert.equal(f.releases(), 2); assert.equal(f.processChecks(), 4)
    assert.equal(existsSync(join(f.dir, 'buyin-restriction-storage-fault.lock')), false)
    assert.ok(existsSync(f.snapshotPath))
  } finally { f.close() }
})

test('old host port or process busy prevents DB writes; in-progress failure retains a stop marker', async () => {
  const f = fixture()
  try {
    await assert.rejects(migrateLegacyStop(f.snapshotPath, f.dir, key, { ...f.deps,
      reserve: async () => { throw new Error('migration_legacy_port_busy') } }), /migration_legacy_port_busy/)
    await assert.rejects(migrateLegacyStop(f.snapshotPath, f.dir, key, { ...f.deps,
      checkProcesses: async () => { throw new Error('migration_process_check_failed') } }), /migration_failed_review_required/)
    assert.equal(existsSync(join(f.dir, 'buyin-restriction-storage-fault.lock')), true)
    rmSync(join(f.dir, 'buyin-restriction-storage-fault.lock'))
    let checks = 0
    await assert.rejects(migrateLegacyStop(f.snapshotPath, f.dir, key, { ...f.deps,
      checkProcesses: async () => { if (++checks === 2) throw new Error('migration_process_check_failed') } }), /migration_failed_review_required/)
    assert.equal(existsSync(join(f.dir, 'buyin-restriction-storage-fault.lock')), true)
    assert.match(readFileSync(join(f.dir, 'buyin-restriction-storage-fault.lock'), 'utf8'), /^manual-review-required /)
    const db = new DatabaseSync(f.dbPath)
    try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='buyin_restriction_state'").get(), undefined) } finally { db.close() }
  } finally { f.close() }
})

test('existing marker, malformed evidence and concurrent database writer never remove or overwrite data', async () => {
  const f = fixture()
  try {
    const marker = join(f.dir, 'buyin-restriction-storage-fault.lock')
    writeFileSync(marker, 'preexisting user data')
    await assert.rejects(migrateLegacyStop(f.snapshotPath, f.dir, key, f.deps), /migration_failed_review_required/)
    assert.equal(readFileSync(marker, 'utf8'), 'preexisting user data')
    rmSync(marker)
    writeFileSync(f.snapshotPath, JSON.stringify({ ...f.snapshot, restricted: false }))
    await assert.rejects(migrateLegacyStop(f.snapshotPath, f.dir, key, f.deps), /migration_failed_review_required/)
    assert.equal(existsSync(marker), true)
    rmSync(marker)
    writeFileSync(f.snapshotPath, JSON.stringify(f.snapshot))
    const locked = new DatabaseSync(f.dbPath); locked.exec('BEGIN EXCLUSIVE')
    try { await assert.rejects(migrateLegacyStop(f.snapshotPath, f.dir, key, f.deps), /migration_failed_review_required/) }
    finally { locked.exec('ROLLBACK'); locked.close() }
    assert.equal(existsSync(marker), true)
  } finally { f.close() }
})
