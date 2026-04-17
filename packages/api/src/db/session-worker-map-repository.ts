import { eq } from 'drizzle-orm';
import { getDb, schema } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A persisted session → worker routing entry.
 */
export interface SessionWorkerMapEntry {
  /** Session UUID. */
  sessionId: string;
  /** Worker UUID. */
  workerId: string;
  /** Worker base URL at assignment time. */
  workerUrl: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Data-access layer for the `session_worker_map` table.
 *
 * Used exclusively by the master node to persist and query session→worker
 * routing entries for crash-recovery across restarts.
 *
 * All methods are synchronous (better-sqlite3 is a synchronous driver).
 */
export class SessionWorkerMapRepository {
  /**
   * Insert a new session→worker mapping.
   *
   * @param entry - The mapping to persist.
   */
  create(entry: SessionWorkerMapEntry): void {
    getDb()
      .insert(schema.sessionWorkerMap)
      .values({
        sessionId: entry.sessionId,
        workerId: entry.workerId,
        workerUrl: entry.workerUrl,
        createdAt: entry.createdAt,
      })
      .run();
  }

  /**
   * Look up the worker mapping for a given session ID.
   *
   * @param sessionId - The session UUID to look up.
   * @returns The mapping entry, or `null` if not found.
   */
  findBySessionId(sessionId: string): SessionWorkerMapEntry | null {
    const row = getDb()
      .select()
      .from(schema.sessionWorkerMap)
      .where(eq(schema.sessionWorkerMap.sessionId, sessionId))
      .get();

    if (!row) return null;

    return {
      sessionId: row.sessionId,
      workerId: row.workerId,
      workerUrl: row.workerUrl,
      createdAt: row.createdAt,
    };
  }

  /**
   * Retrieve all session→worker mappings for a given worker.
   *
   * Useful when a worker goes offline and the master needs to mark all
   * its sessions as errored.
   *
   * @param workerId - The worker UUID to query.
   * @returns Array of matching entries (may be empty).
   */
  findByWorkerId(workerId: string): SessionWorkerMapEntry[] {
    return getDb()
      .select()
      .from(schema.sessionWorkerMap)
      .where(eq(schema.sessionWorkerMap.workerId, workerId))
      .all()
      .map((row) => ({
        sessionId: row.sessionId,
        workerId: row.workerId,
        workerUrl: row.workerUrl,
        createdAt: row.createdAt,
      }));
  }

  /**
   * Retrieve all session→worker mappings.
   *
   * Used during master startup to rehydrate the in-memory routing table.
   *
   * @returns All entries in the table.
   */
  findAll(): SessionWorkerMapEntry[] {
    return getDb()
      .select()
      .from(schema.sessionWorkerMap)
      .all()
      .map((row) => ({
        sessionId: row.sessionId,
        workerId: row.workerId,
        workerUrl: row.workerUrl,
        createdAt: row.createdAt,
      }));
  }

  /**
   * Delete the session→worker mapping for the given session ID.
   *
   * Called when a session is terminated so stale entries don't accumulate.
   *
   * @param sessionId - The session UUID whose mapping should be removed.
   */
  deleteBySessionId(sessionId: string): void {
    getDb()
      .delete(schema.sessionWorkerMap)
      .where(eq(schema.sessionWorkerMap.sessionId, sessionId))
      .run();
  }

  /**
   * Delete all session→worker mappings for a given worker.
   *
   * Called when a worker is deregistered or marked permanently offline.
   *
   * @param workerId - The worker UUID whose session mappings should be removed.
   * @returns The number of rows deleted.
   */
  deleteByWorkerId(workerId: string): number {
    const result = getDb()
      .delete(schema.sessionWorkerMap)
      .where(eq(schema.sessionWorkerMap.workerId, workerId))
      .run();

    return result.changes;
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton — import this rather than constructing directly. */
export const sessionWorkerMapRepository = new SessionWorkerMapRepository();
