import { randomUUID } from 'node:crypto';
import { mkdirSync, createReadStream } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { Platform } from '@web-mobile-simulator/shared';
import {
  appLibraryRepository,
  type AppLibraryEntry,
} from '../db/app-library-repository.js';
import { appInstallService } from './app-install.js';
import { sessionManagerService } from './session-manager.js';
import { androidEmulatorService } from './android-emulator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[AppLibraryService]';

/**
 * Root directory (relative to the project working directory) where uploaded
 * app library files are stored.
 */
const APPS_STORAGE_ROOT = 'data/apps';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Return an ISO-8601 timestamp for the current moment. */
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Upload input type
// ---------------------------------------------------------------------------

/**
 * Raw file data passed to {@link AppLibraryService.uploadApp}.
 *
 * Mirrors the shape provided by `@fastify/multipart` after the stream has
 * been fully consumed into a `Buffer`.
 */
export interface UploadedFile {
  /** Original filename as reported by the client (e.g. `"MyApp.ipa"`). */
  filename: string;
  /** Full file contents as a `Buffer`. */
  buffer: Buffer;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Business-logic layer for the persistent app library.
 *
 * Handles file storage, database persistence, and installation of library
 * apps into active simulator sessions.
 *
 * Export the singleton {@link appLibraryService} rather than constructing
 * instances directly.
 */
export class AppLibraryService {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Save an uploaded app file to disk and create a database entry.
   *
   * The file is stored at `data/apps/<userId>/<uuid>-<filename>` relative to
   * the current working directory.  The directory is created if it does not
   * already exist.
   *
   * @param userId   - User identifier from the `x-user-id` request header.
   * @param platform - Target platform: `'ios'` or `'android'`.
   * @param file     - Uploaded file data (filename + buffer).
   * @returns The newly created {@link AppLibraryEntry}.
   */
  async uploadApp(
    userId: string,
    platform: Platform,
    file: UploadedFile,
  ): Promise<AppLibraryEntry> {
    const id = randomUUID();
    const userDir = join(APPS_STORAGE_ROOT, userId);

    // Ensure the per-user storage directory exists.
    mkdirSync(userDir, { recursive: true });

    const storedFilename = `${id}${extname(file.filename)}`;
    const storagePath = join(userDir, storedFilename);

    log(`Saving "${file.filename}" to "${storagePath}" for user "${userId}"…`);
    await writeFile(storagePath, file.buffer);

    const timestamp = now();
    const entry: AppLibraryEntry = {
      id,
      userId,
      fileName: file.filename,
      platform,
      fileSize: file.buffer.byteLength,
      storagePath,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    appLibraryRepository.create(entry);
    log(`App "${file.filename}" (id: ${id}) saved to library for user "${userId}".`);

    return entry;
  }

  /**
   * List all apps in a user's library, optionally filtered by platform.
   *
   * @param userId   - User identifier to list apps for.
   * @param platform - When provided, only apps for this platform are returned.
   * @returns An array of {@link AppLibraryEntry} records.
   */
  listApps(userId: string, platform?: Platform): AppLibraryEntry[] {
    if (platform !== undefined) {
      return appLibraryRepository.findByUserIdAndPlatform(userId, platform);
    }
    return appLibraryRepository.findByUserId(userId);
  }

  /**
   * Retrieve a single app library entry by its ID.
   *
   * @param id - The app entry UUID to look up.
   * @returns The matching {@link AppLibraryEntry}, or `null` if not found.
   */
  getApp(id: string): AppLibraryEntry | null {
    return appLibraryRepository.findById(id);
  }

  /**
   * Delete an app from the library — removes the file from disk and the DB row.
   *
   * If the file does not exist on disk the deletion is still considered
   * successful (the DB row is always removed).
   *
   * @param id - The app entry UUID to delete.
   * @returns `true` if the entry existed and was deleted; `false` if not found.
   */
  async deleteApp(id: string): Promise<boolean> {
    const entry = appLibraryRepository.findById(id);
    if (!entry) return false;

    log(`Deleting app "${entry.fileName}" (id: ${id}) from library…`);

    // Remove the file from disk — ignore errors if the file is already gone.
    await unlink(entry.storagePath).catch((err: unknown) => {
      console.warn(
        `${LOG_PREFIX} WARN  Could not delete file "${entry.storagePath}": ${String(err)}`,
      );
    });

    appLibraryRepository.delete(id);
    log(`App "${entry.fileName}" (id: ${id}) deleted from library.`);

    return true;
  }

  /**
   * Install a library app into an active simulator session.
   *
   * Reads the stored file from disk and delegates to
   * {@link appInstallService.installApp} — the same service used by the
   * per-session upload route.
   *
   * @param appId     - The app library entry UUID to install.
   * @param sessionId - The target session UUID.
   * @returns The {@link AppInstallResult} from the install service.
   * @throws If the app entry or session is not found, or the session is not active.
   */
  async installApp(
    appId: string,
    sessionId: string,
  ): Promise<{ success: boolean; message: string }> {
    // --- Resolve the app entry ---
    const entry = appLibraryRepository.findById(appId);
    if (!entry) {
      throw new Error(`App library entry "${appId}" not found.`);
    }

    // --- Resolve the session ---
    const session = sessionManagerService.getSession(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    if (session.status !== 'active') {
      throw new Error(
        `Session "${sessionId}" is not active (current status: "${session.status}"). ` +
          `The session must be active to install apps.`,
      );
    }

    // --- Validate platform compatibility ---
    const { platform } = session.device;
    if (entry.platform !== platform) {
      throw new Error(
        `App platform "${entry.platform}" does not match session platform "${platform}".`,
      );
    }

    // --- Resolve the platform device ID ---
    let platformDeviceId: string;

    if (platform === 'ios') {
      platformDeviceId = session.device.platformDeviceId;
    } else {
      const avdName = session.device.platformDeviceId;
      const adbPort = await androidEmulatorService.getAdbPort(avdName);

      if (adbPort === null) {
        throw new Error(
          `Cannot determine ADB serial for Android emulator "${avdName}". ` +
            `Ensure the emulator is running and reachable via adb.`,
        );
      }

      platformDeviceId = `emulator-${adbPort}`;
    }

    log(
      `Installing library app "${entry.fileName}" (id: ${appId}) ` +
        `on ${platform} device "${platformDeviceId}" via session "${sessionId}"…`,
    );

    // --- Delegate to the existing install service ---
    const result = await appInstallService.installApp(
      entry.storagePath,
      platform,
      platformDeviceId,
      entry.fileName,
    );

    return { success: result.success, message: result.message };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const appLibraryService = new AppLibraryService();
