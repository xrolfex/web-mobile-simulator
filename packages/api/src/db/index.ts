import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Drizzle database instance type for this schema. */
export type Db = ReturnType<typeof drizzle<typeof schema>>;

// ---------------------------------------------------------------------------
// Module-level singleton (lazily initialised)
// ---------------------------------------------------------------------------

let _db: Db | null = null;

/**
 * Return the singleton Drizzle database instance, creating it on first call.
 *
 * The database file and its parent directory are created automatically if they
 * do not exist. The SQLite connection uses WAL mode for better concurrent read
 * performance.
 *
 * This function is deliberately lazy so that importing the `db` module does
 * not open a file on disk — useful for test environments where the DB should
 * not be initialised automatically.
 *
 * @returns The shared Drizzle `db` instance.
 */
export function getDb(): Db {
  if (_db !== null) return _db;

  // Strip the optional `file:` URI prefix to get a plain file-system path.
  const dbPath = config.databaseUrl.replace(/^file:/, '');

  // Ensure the parent directory exists before trying to open the file.
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);

  // WAL mode allows readers and a single writer to operate concurrently.
  sqlite.pragma('journal_mode = WAL');

  _db = drizzle(sqlite, { schema });
  return _db;
}

export { schema };
