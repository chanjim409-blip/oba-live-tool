import type { HostBridgeDb } from './sqliteDb'

export type PlatformStopCode = 'host_login_expired' | 'host_permission_denied' | 'host_rate_limited' | 'host_platform_restricted'
const valid = new Set<PlatformStopCode>(['host_login_expired', 'host_permission_denied', 'host_rate_limited', 'host_platform_restricted'])

/** One host-wide Buyin stop; no account identifiers, response bodies or credentials are stored. */
export class PlatformRestrictionStore {
  constructor(private readonly db: HostBridgeDb, private readonly now: () => number = Date.now) {
    db.database.exec(`CREATE TABLE IF NOT EXISTS buyin_restriction_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), code TEXT NOT NULL, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS buyin_restriction_history (at TEXT NOT NULL, event TEXT NOT NULL, code TEXT NOT NULL);`)
  }

  read(): PlatformStopCode | null {
    const row = this.db.prepare('SELECT code FROM buyin_restriction_state WHERE singleton=1').get<{ code: string }>()
    if (!row) return null
    if (!valid.has(row.code as PlatformStopCode)) throw new Error('buyin_restriction_state_invalid')
    return row.code as PlatformStopCode
  }

  record(code: PlatformStopCode): void {
    if (!valid.has(code)) throw new Error('buyin_restriction_code_invalid')
    const at = new Date(this.now()).toISOString()
    this.db.database.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.read()
      if (!previous) {
        this.db.prepare('INSERT INTO buyin_restriction_state(singleton,code,observed_at) VALUES(1,?,?)').run(code, at)
        this.db.prepare('INSERT INTO buyin_restriction_history(at,event,code) VALUES(?,?,?)').run(at, 'stopped', code)
      }
      this.db.database.exec('COMMIT')
    } catch (error) { this.db.database.exec('ROLLBACK'); throw error }
  }
}
