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
