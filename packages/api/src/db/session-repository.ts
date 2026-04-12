import { eq } from 'drizzle-orm';
import { getDb, schema } from './index.js';
import type {
  Session,
  SessionStatus,
  SimulatorDevice,
} from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal session shape that extends the public `Session` with platform-
 * specific identifiers required for device cleanup on termination.
 */
export interface StoredSession extends Session {
  /** iOS Simulator UDID — present only for `platform === 'ios'` sessions. */
  _iosUdid?: string;
  /** Android AVD name — present only for `platform === 'android'` sessions. */
  _androidAvdName?: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Data-access layer for `sessions` table operations.
 *
 * All methods are synchronous — `better-sqlite3` is a synchronous driver and
 * Drizzle wraps it accordingly.  Callers do not need to `await` these methods.
 */
export class SessionRepository {
  /**
   * Insert a new session row into the database.
   *
   * @param session - The session to persist, including internal platform IDs.
   */
  create(session: StoredSession): void {
    getDb()
      .insert(schema.sessions)
      .values({
        id: session.id,
        status: session.status,
        platform: session.device.platform,
        deviceJson: JSON.stringify(session.device),
        streamUrl: session.streamUrl ?? null,
        proxyPort: session.proxyPort ?? null,
        iosUdid: session._iosUdid ?? null,
        androidAvdName: session._androidAvdName ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .run();
  }

  /**
   * Update an existing session row in the database.
   *
   * Only mutable fields are updated; `id`, `createdAt`, and `platform` are
   * immutable after creation.
   *
   * @param session - The session with updated values to persist.
   */
  update(session: StoredSession): void {
    getDb()
      .update(schema.sessions)
      .set({
        status: session.status,
        deviceJson: JSON.stringify(session.device),
        streamUrl: session.streamUrl ?? null,
        proxyPort: session.proxyPort ?? null,
        iosUdid: session._iosUdid ?? null,
        androidAvdName: session._androidAvdName ?? null,
        updatedAt: session.updatedAt,
      })
      .where(eq(schema.sessions.id, session.id))
      .run();
  }

  /**
   * Retrieve a single session by its ID.
   *
   * @param id - The session UUID to look up.
   * @returns The matching `StoredSession`, or `null` if no row exists.
   */
  findById(id: string): StoredSession | null {
    const row = getDb()
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .get();

    if (!row) return null;
    return this.rowToSession(row);
  }

  /**
   * List all sessions, optionally filtered by status.
   *
   * @param status - When provided, only sessions with this status are returned.
   * @returns An array of matching `StoredSession` records.
   */
  findAll(status?: SessionStatus): StoredSession[] {
    if (status !== undefined) {
      return getDb()
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.status, status))
        .all()
        .map((row) => this.rowToSession(row));
    }

    return getDb()
      .select()
      .from(schema.sessions)
      .all()
      .map((row) => this.rowToSession(row));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Map a raw database row to a `StoredSession` object.
   *
   * Deserialises the `device_json` column back into a `SimulatorDevice` and
   * converts nullable database columns to `undefined` for optional fields.
   *
   * @param row - A row returned from the `sessions` table.
   * @returns The hydrated `StoredSession`.
   */
  private rowToSession(
    row: typeof schema.sessions.$inferSelect,
  ): StoredSession {
    const device = JSON.parse(row.deviceJson) as SimulatorDevice;

    return {
      id: row.id,
      device,
      status: row.status as SessionStatus,
      streamUrl: row.streamUrl ?? undefined,
      proxyPort: row.proxyPort ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      _iosUdid: row.iosUdid ?? undefined,
      _androidAvdName: row.androidAvdName ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton — import this rather than constructing directly. */
export const sessionRepository = new SessionRepository();
