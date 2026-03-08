import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@im/db-schema'
import path from 'node:path'
import { app } from 'electron'
import { runMigrations } from './migrations'

let _db: BetterSQLite3Database<typeof schema> | null = null
let _sqlite: Database.Database | null = null

/**
 * Inisialisasi database SQLite lokal.
 * File tersimpan di userData Electron:
 * Windows: %APPDATA%\instant-messenger\messenger.db
 * macOS:   ~/Library/Application Support/instant-messenger/messenger.db
 * Linux:   ~/.config/instant-messenger/messenger.db
 */
export function initDatabase(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db

  const dbPath = path.join(app.getPath('userData'), 'messenger.db')
  console.log('[db] Database path:', dbPath)

  _sqlite = new Database(dbPath)

  // WAL mode untuk performa lebih baik
  _sqlite.pragma('journal_mode = WAL')
  _sqlite.pragma('foreign_keys = ON')
  _sqlite.pragma('synchronous = NORMAL')

  runMigrations(_sqlite)

  _db = drizzle(_sqlite, { schema })
  return _db
}

export function getDatabase(): BetterSQLite3Database<typeof schema> {
  if (!_db) throw new Error('Database belum diinisialisasi.')
  return _db
}

export function closeDatabase(): void {
  _sqlite?.close()
  _sqlite = null
  _db = null
}
