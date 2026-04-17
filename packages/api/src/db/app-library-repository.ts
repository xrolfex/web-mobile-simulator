import { eq, and } from 'drizzle-orm';
import { getDb, schema } from './index.js';
import type { Platform } from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single entry in the persistent app library.
 *
 * Mirrors the `app_library` table row with idiomatic camelCase field names.
 */
export interface AppLibraryEntry {
  /** App entry UUID — primary key. */
  id: string;
  /** Simple user identifier supplied via the `x-user-id` request header. */
  userId: string;
  /** Original filename as uploaded by the user (e.g. `"MyApp.ipa"`). */
  fileName: string;
  /** Target platform: `'ios'` or `'android'`. */
  platform: Platform;
  /** File size in bytes. */
  fileSize: number;
  /** Relative path on disk where the file is stored (relative to project root). */
  storagePath: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/**
 * Data-access layer for `app_library` table operations.
 *
 * All methods are synchronous — `better-sqlite3` is a synchronous driver and
 * Drizzle wraps it accordingly.  Callers do not need to `await` these methods.
 */
export class AppLibraryRepository {
  /**
   * Insert a new app library entry into the database.
   *
   * @param entry - The entry to persist.
   */
  create(entry: AppLibraryEntry): void {
    getDb()
      .insert(schema.appLibrary)
      .values({
        id: entry.id,
        userId: entry.userId,
        fileName: entry.fileName,
        platform: entry.platform,
        fileSize: entry.fileSize,
        storagePath: entry.storagePath,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })
      .run();
  }

  /**
   * Retrieve a single app library entry by its ID.
   *
   * @param id - The entry UUID to look up.
   * @returns The matching {@link AppLibraryEntry}, or `null` if no row exists.
   */
  findById(id: string): AppLibraryEntry | null {
    const row = getDb()
      .select()
      .from(schema.appLibrary)
      .where(eq(schema.appLibrary.id, id))
      .get();

    if (!row) return null;
    return this.rowToEntry(row);
  }

  /**
   * List all app library entries belonging to a specific user.
   *
   * @param userId - The user identifier to filter by.
   * @returns An array of matching {@link AppLibraryEntry} records.
   */
  findByUserId(userId: string): AppLibraryEntry[] {
    return getDb()
      .select()
      .from(schema.appLibrary)
      .where(eq(schema.appLibrary.userId, userId))
      .all()
      .map((row: typeof schema.appLibrary.$inferSelect) => this.rowToEntry(row));
  }

  /**
   * List all app library entries for a user filtered by platform.
   *
   * @param userId   - The user identifier to filter by.
   * @param platform - The platform to filter by (`'ios'` or `'android'`).
   * @returns An array of matching {@link AppLibraryEntry} records.
   */
  findByUserIdAndPlatform(userId: string, platform: Platform): AppLibraryEntry[] {
    return getDb()
      .select()
      .from(schema.appLibrary)
      .where(
        and(
          eq(schema.appLibrary.userId, userId),
          eq(schema.appLibrary.platform, platform),
        ),
      )
      .all()
      .map((row: typeof schema.appLibrary.$inferSelect) => this.rowToEntry(row));
  }

  /**
   * Delete a single app library entry from the database by its ID.
   *
   * @param id - The entry UUID to delete.
   */
  delete(id: string): void {
    getDb()
      .delete(schema.appLibrary)
      .where(eq(schema.appLibrary.id, id))
      .run();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Map a raw database row to an {@link AppLibraryEntry} object.
   *
   * @param row - A row returned from the `app_library` table.
   * @returns The hydrated {@link AppLibraryEntry}.
   */
  private rowToEntry(
    row: typeof schema.appLibrary.$inferSelect,
  ): AppLibraryEntry {
    return {
      id: row.id,
      userId: row.userId,
      fileName: row.fileName,
      platform: row.platform as Platform,
      fileSize: row.fileSize,
      storagePath: row.storagePath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton — import this rather than constructing directly. */
export const appLibraryRepository = new AppLibraryRepository();
