import dotenv from 'dotenv';
import { DEFAULT_API_PORT } from '@web-mobile-simulator/shared';

dotenv.config();

/** Parsed, validated configuration derived from environment variables. */
export const config = {
  port: parseInt(process.env.API_PORT || String(DEFAULT_API_PORT), 10),
  host: process.env.API_HOST || '0.0.0.0',
  xcodePath: process.env.XCODE_PATH || '/Applications/Xcode.app',
  androidSdkRoot:
    process.env.ANDROID_SDK_ROOT || `${process.env.HOME}/Library/Android/sdk`,
  databaseUrl: process.env.DATABASE_URL || 'file:./data/simulator.db',
  vncProxyPortRange: {
    start: parseInt(process.env.VNC_PROXY_PORT_RANGE_START || '6900', 10),
    end: parseInt(process.env.VNC_PROXY_PORT_RANGE_END || '6999', 10),
  },
} as const;
