import { open, type DB } from '@op-engineering/op-sqlite'
import { drizzle, type OPSQLiteDatabase } from 'drizzle-orm/op-sqlite'
import * as schema from '@im/db-schema'
import { runMigrations } from './migrations'

const DB_NAME = 'messenger.db'

let _db: OPSQLiteDatabase<typeof schema> | null = null
let _sqlite: DB | null = null

/**
 * Inisialisasi database SQLite lokal.
 * Dipanggil satu kali saat app start.
 */
export async function initDatabase(): Promise<OPSQLiteDatabase<typeof schema>> {
  if (_db) return _db

  _sqlite = open({ name: DB_NAME })
  _db = drizzle(_sqlite, { schema })

  await runMigrations(_sqlite)

  return _db
}

export function getDatabase(): OPSQLiteDatabase<typeof schema> {
  if (!_db) throw new Error('Database belum diinisialisasi. Panggil initDatabase() terlebih dahulu.')
  return _db
}

export function closeDatabase(): void {
  _sqlite?.close()
  _sqlite = null
  _db = null
}
