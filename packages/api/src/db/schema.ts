import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * The `sessions` table stores all simulator sessions including their lifecycle
 * state, device configuration (as JSON), stream info, and cleanup identifiers.
 *
 * Complex nested device data (`SimulatorDevice`) is serialised to `device_json`
 * because it contains multiple levels of nested objects that only need to be
 * retrieved by session ID — never queried by individual nested fields.
 */
export const sessions = sqliteTable('sessions', {
  /** Session UUID — primary key. */
  id: text('id').primaryKey(),

  /** Current lifecycle status of the session. */
  status: text('status').notNull(), // SessionStatus

  /** Platform for top-level filtering without needing to parse device_json. */
  platform: text('platform').notNull(), // 'ios' | 'android'

  /** Full `SimulatorDevice` object serialised to a JSON string. */
  deviceJson: text('device_json').notNull(),

  /** WebSocket URL for the display stream (null when not yet active). */
  streamUrl: text('stream_url'),

  /** Port the VNC proxy was running on — retained for schema compatibility, always null now. */
  proxyPort: integer('proxy_port'),

  /** iOS Simulator UDID — present only for `platform === 'ios'` sessions. */
  iosUdid: text('ios_udid'),

  /** Android AVD name — present only for `platform === 'android'` sessions. */
  androidAvdName: text('android_avd_name'),

  /** ISO-8601 creation timestamp. */
  createdAt: text('created_at').notNull(),

  /** ISO-8601 last-updated timestamp. */
  updatedAt: text('updated_at').notNull(),
});

/**
 * The `app_library` table stores persistent app binaries (.ipa / .apk) that
 * users upload to their personal library.  Apps can be installed into any
 * active session without re-uploading.
 */
export const appLibrary = sqliteTable('app_library', {
  /** App entry UUID — primary key. */
  id: text('id').primaryKey(),

  /** Simple user identifier supplied via the `x-user-id` request header. */
  userId: text('user_id').notNull(),

  /** Original filename as uploaded by the user (e.g. `"MyApp.ipa"`). */
  fileName: text('file_name').notNull(),

  /** Target platform: `'ios'` or `'android'`. */
  platform: text('platform').notNull(),

  /** File size in bytes. */
  fileSize: integer('file_size').notNull(),

  /** Relative path on disk where the file is stored (relative to project root). */
  storagePath: text('storage_path').notNull(),

  /** ISO-8601 creation timestamp. */
  createdAt: text('created_at').notNull(),

  /** ISO-8601 last-updated timestamp. */
  updatedAt: text('updated_at').notNull(),
});

/**
 * The `session_worker_map` table records which worker node owns each session.
 * Used by the master node to route session-specific requests to the correct worker.
 * Only populated in `master` mode — ignored in `standalone` and `worker` modes.
 */
export const sessionWorkerMap = sqliteTable('session_worker_map', {
  /** Session UUID — matches the `id` in the `sessions` table on the owning worker. */
  sessionId: text('session_id').primaryKey(),

  /** UUID of the worker that owns this session — matches `WorkerNode.id`. */
  workerId: text('worker_id').notNull(),

  /**
   * Base URL of the worker at the time the session was assigned.
   * Stored here so the master can proxy requests even if the worker re-registers
   * with a different URL (edge case: should not normally change).
   */
  workerUrl: text('worker_url').notNull(),

  /** ISO-8601 timestamp of when this mapping was created. */
  createdAt: text('created_at').notNull(),
});
