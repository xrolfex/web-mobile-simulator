import { sql } from 'drizzle-orm';
import { getDb } from './index.js';

const LOG_PREFIX = '[Database]';

/**
 * Initialise the SQLite database by creating required tables and indexes if
 * they do not already exist.
 *
 * This is intentionally a lightweight "push" approach rather than a full
 * migration runner — the schema is simple enough that `CREATE TABLE IF NOT
 * EXISTS` statements are sufficient and idempotent.
 *
 * Call this once at server startup before any repository operations.
 */
export function initializeDatabase(): void {
  const db = getDb();

  // Create the sessions table if it doesn't already exist.
  db.run(sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      platform TEXT NOT NULL,
      device_json TEXT NOT NULL,
      stream_url TEXT,
      proxy_port INTEGER,
      ios_udid TEXT,
      android_avd_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Index on status so listing by status (e.g. 'active') is efficient.
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)
  `);

  console.log(`${LOG_PREFIX} Initialized successfully`);
}
