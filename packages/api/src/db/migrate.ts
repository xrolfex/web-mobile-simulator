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

  // Create the app_library table if it doesn't already exist.
  db.run(sql`
    CREATE TABLE IF NOT EXISTS app_library (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Index on user_id so listing a user's apps is efficient.
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_app_library_user_id ON app_library(user_id)
  `);

  // Create the session_worker_map table if it doesn't already exist.
  // Only used by master nodes to persist session→worker routing.
  db.run(sql`
    CREATE TABLE IF NOT EXISTS session_worker_map (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      worker_url TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Index so the master can quickly look up all sessions for a given worker
  // (e.g. when a worker goes offline and all its sessions need to be errored).
  db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_swm_worker_id ON session_worker_map(worker_id)
  `);

  console.log(`${LOG_PREFIX} Initialized successfully`);
}
