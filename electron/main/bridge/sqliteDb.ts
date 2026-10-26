import { DatabaseSync } from 'node:sqlite'

/**
 * 业务仓 `HostIdentityBoundary` 只用到数据库的三件事：`database.exec`、`prepare().all/get/run`。
 * 这里用一个很小的适配层顶上，避免把业务仓整套 store 搬进宿主：宿主只需要一个自己的私有库文件，
 * 用来持久化"动作 → 回执"的幂等记录（重复请求返回原回执；不确定的结果不会被重发）。
 *
 * 位置放在 Electron 的 userData 目录，不写进仓库、不放进业务库，避免两个进程写同一个文件。
 */
export interface HostBridgeDb {
  database: { exec(sql: string): void }
  prepare(sql: string): {
    all<T = unknown>(...params: Array<string | number | null>): T[]
    get<T = unknown>(...params: Array<string | number | null>): T | undefined
    run(...params: Array<string | number | null>): unknown
  }
}

export interface OpenedHostBridgeDb {
  db: HostBridgeDb
  close(): void
}

export function openHostBridgeDb(file: string): OpenedHostBridgeDb {
  const database = new DatabaseSync(file)
  // WAL + 同步 NORMAL：宿主崩掉也不该丢已有回执；这份库只存回执与审计，不值得 FULL 的写放大。
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  const db: HostBridgeDb = {
    database: {
      exec: sql => {
        database.exec(sql)
      },
    },
    prepare: sql => {
      const statement = database.prepare(sql)
      return {
        all: (...params) => statement.all(...params) as never,
        get: (...params) => statement.get(...params) as never,
        run: (...params) => statement.run(...params),
      }
    },
  }
  return { db, close: () => database.close() }
}
