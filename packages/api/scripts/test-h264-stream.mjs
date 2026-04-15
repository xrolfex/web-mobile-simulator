/**
 * test-h264-stream.mjs
 *
 * Self-contained test script that:
 *   1. Starts the API server (node dist/server.js)
 *   2. Waits for the server to be ready
 *   3. Creates an iOS simulator session
 *   4. Waits 20 s for the simulator + capture binary to boot
 *   5. Connects to the H.264 WebSocket stream + opens the .h264 file
 *   6. Captures for CAPTURE_DURATION_S seconds while sending tap/swipe
 *      interactions every INTERACTION_INTERVAL_MS milliseconds to generate motion
 *   7. Converts the .h264 file to .mp4 via ffmpeg, runs ffprobe, and opens
 *      the .mp4 for visual inspection
 *   Cleanup: deletes the session and kills the API server
 *
 * Usage (from packages/api/):
 *   node scripts/test-h264-stream.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Bootstrap: resolve ws relative to this script's location so the script can
// be run from any working directory as long as node_modules/ws is present
// inside packages/api/.
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Base URL for the API server. */
const API_BASE = 'http://localhost:3000';

/** Path to the diagnostic H.264 file that captures all raw Annex-B NALUs. */
const H264_FILE_PATH = '/tmp/wms-h264-capture.h264';

/** Path for the output MP4 file. */
const MP4_FILE_PATH = '/tmp/wms-h264-capture.mp4';

/** How long (ms) to wait between server-ready polls. */
const POLL_INTERVAL_MS = 500;

/** Maximum number of polls before giving up. */
const POLL_MAX_ATTEMPTS = 60; // 30 s total

/** How many milliseconds to wait after session creation before connecting WS. */
const SIMULATOR_BOOT_WAIT_MS = 20_000;

/** How often (ms) to print frame statistics. */
const STATS_INTERVAL_MS = 5_000;

/** How long (seconds) to capture H.264 frames after stream starts. */
const CAPTURE_DURATION_S = 15;

/** How often (ms) to send an interaction (tap or swipe) to generate motion. */
const INTERACTION_INTERVAL_MS = 3000;

/** iOS session parameters. */
const IOS_SESSION_BODY = {
  platform: 'ios',
  deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
};

// ---------------------------------------------------------------------------
// Interaction sequence
//
// Each entry is either a tap or a swipe that will cause visible changes on an
// iOS home screen.  The sequence repeats cyclically.
// ---------------------------------------------------------------------------

/** @type {Array<{ kind: 'tap', x: number, y: number, deviceX: number, deviceY: number } | { kind: 'swipe', startX: number, startY: number, endX: number, endY: number, deviceStartX: number, deviceStartY: number, deviceEndX: number, deviceEndY: number }>} */
const INTERACTION_SEQUENCE = [
  // 1. Tap center — may open app or cause visual ripple
  { kind: 'tap', x: 0.5, y: 0.5, deviceX: 195, deviceY: 450 },
  // 2. Swipe left — scroll home screen pages right-to-left
  { kind: 'swipe', startX: 0.8, startY: 0.5, endX: 0.2, endY: 0.5, deviceStartX: 312, deviceStartY: 450, deviceEndX: 78, deviceEndY: 450 },
  // 3. Tap somewhere else
  { kind: 'tap', x: 0.3, y: 0.3, deviceX: 117, deviceY: 270 },
  // 4. Swipe right — scroll home screen pages left-to-right
  { kind: 'swipe', startX: 0.2, startY: 0.5, endX: 0.8, endY: 0.5, deviceStartX: 78, deviceStartY: 450, deviceEndX: 312, deviceEndY: 450 },
  // 5. Swipe up from bottom — open app switcher
  { kind: 'swipe', startX: 0.5, startY: 0.95, endX: 0.5, endY: 0.4, deviceStartX: 195, deviceStartY: 855, deviceEndX: 195, deviceEndY: 360 },
  // 6. Tap to dismiss
  { kind: 'tap', x: 0.5, y: 0.5, deviceX: 195, deviceY: 450 },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The spawned API server child process (set in step 1). */
let serverProcess = null;

/** The session ID returned by POST /api/sessions. */
let sessionId = null;

/** Write stream for saving raw Annex-B NALU data to {@link H264_FILE_PATH}. */
let h264FileStream = null;

/** The WebSocket connection to the H.264 stream. */
let streamSocket = null;

// ---------------------------------------------------------------------------
// Frame statistics
// ---------------------------------------------------------------------------

/** Total frames received since stream start. */
let totalFrames = 0;

/** Total keyframes received. */
let totalKeyframes = 0;

/** Total bytes of NALU data received. */
let totalBytes = 0;

/** Frames received in the current stats window. */
let windowFrames = 0;

/** Keyframes received in the current stats window. */
let windowKeyframes = 0;

/** Bytes of NALU data received in the current stats window. */
let windowBytes = 0;

/** Timestamp (ms) when the first H.264 frame arrived. */
let firstFrameMs = 0;

/** Interval handle for periodic stats printing. */
let statsInterval = null;

/** Interval handle for periodic interaction sending. */
let interactionInterval = null;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Log a message to stdout.
 *
 * @param {string} message - Message to print.
 */
function log(message) {
  console.log(message);
}

/**
 * Perform an HTTP request and return the parsed JSON body along with the
 * status code.
 *
 * @param {string} method  - HTTP method (GET, POST, DELETE, …).
 * @param {string} url     - Full URL to request.
 * @param {unknown} [body] - Optional JSON-serialisable body.
 * @returns {Promise<{ status: number; data: unknown }>}
 */
function httpRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const parsedUrl = new URL(url);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const data = raw ? JSON.parse(raw) : null;
          resolve({ status: res.statusCode ?? 0, data });
        } catch (parseError) {
          reject(new Error(`Failed to parse JSON response: ${parseError.message}`));
        }
      });
    });

    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Sleep for the given number of milliseconds.
 *
 * @param {number} ms - Duration in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a number with locale-aware thousand separators.
 *
 * @param {number} n - Number to format.
 * @returns {string}
 */
function fmt(n) {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// Clean-up
// ---------------------------------------------------------------------------

/** Whether cleanup has already been triggered (guards against double-run). */
let cleaningUp = false;

/**
 * Perform a graceful shutdown:
 *   - Stop the interaction and stats intervals
 *   - Close the .h264 file stream
 *   - Close the WebSocket
 *   - DELETE the session via the API
 *   - Kill the API server child process
 *
 * @returns {Promise<void>}
 */
async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;

  log('\n🧹 Cleaning up...');

  // Stop the interaction timer
  if (interactionInterval !== null) {
    clearInterval(interactionInterval);
    interactionInterval = null;
  }

  // Clear the stats interval
  if (statsInterval !== null) {
    clearInterval(statsInterval);
    statsInterval = null;
  }

  // Close the H.264 diagnostic file and report its size
  if (h264FileStream !== null) {
    await new Promise((resolve) => h264FileStream.end(resolve));
    try {
      const stats = fs.statSync(H264_FILE_PATH);
      log(`   H.264 file saved: ${H264_FILE_PATH} (${fmt(stats.size)} bytes)`);
    } catch {
      // File may not exist if nothing was written
    }
    h264FileStream = null;
  }

  // Close the WebSocket
  if (streamSocket !== null) {
    try {
      streamSocket.close();
    } catch {
      // Ignore errors during cleanup
    }
    streamSocket = null;
  }

  // Delete the session
  if (sessionId !== null) {
    try {
      log(`   Deleting session ${sessionId}...`);
      await httpRequest('DELETE', `${API_BASE}/api/sessions/${sessionId}`);
      log('   Session deleted.');
    } catch (err) {
      log(`   Warning: could not delete session — ${err.message}`);
    }
    sessionId = null;
  }

  // Kill the server process
  if (serverProcess !== null) {
    try {
      serverProcess.kill('SIGTERM');
      log('   API server process terminated.');
    } catch {
      // Ignore
    }
    serverProcess = null;
  }

  log('✅ Done. Goodbye!\n');
  process.exit(0);
}

// Register Ctrl-C handler
process.on('SIGINT', () => {
  cleanup().catch((err) => {
    console.error('Cleanup error:', err);
    process.exit(1);
  });
});

// ---------------------------------------------------------------------------
// Step 1 — Start the API server
// ---------------------------------------------------------------------------

/**
 * Spawn `node dist/server.js` from the packages/api directory.
 *
 * @returns {import('node:child_process').ChildProcess}
 */
function startApiServer() {
  const apiDir = path.join(__dirname, '..');
  const proc = spawn('node', ['dist/server.js'], {
    cwd: apiDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        process.stdout.write(`  [server] ${line}\n`);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const lines = chunk.toString().trim().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        process.stderr.write(`  [server:err] ${line}\n`);
      }
    }
  });

  proc.on('exit', (code, signal) => {
    if (!cleaningUp) {
      log(`\n⚠️  API server exited unexpectedly (code=${code}, signal=${signal})`);
      cleanup().catch(() => process.exit(1));
    }
  });

  return proc;
}

// ---------------------------------------------------------------------------
// Step 2 — Poll until the server responds
// ---------------------------------------------------------------------------

/**
 * Poll `GET /api/sessions` until the server responds with a 2xx status.
 * Throws if the server is not ready after {@link POLL_MAX_ATTEMPTS} attempts.
 *
 * @returns {Promise<void>}
 */
async function waitForServer() {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const { status } = await httpRequest('GET', `${API_BASE}/api/sessions`);
      if (status >= 200 && status < 300) {
        return;
      }
    } catch {
      // Server not yet up — swallow the connection-refused error
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Server did not become ready after ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000} s`,
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Create iOS session
// ---------------------------------------------------------------------------

/**
 * POST /api/sessions to create a new iOS simulator session.
 *
 * @returns {Promise<{ id: string; status: string; streamUrl: string }>}
 */
async function createIosSession() {
  const { status, data } = await httpRequest('POST', `${API_BASE}/api/sessions`, IOS_SESSION_BODY);

  if (status !== 201 || !data?.success) {
    throw new Error(
      `Failed to create iOS session (HTTP ${status}): ${JSON.stringify(data?.error ?? data)}`,
    );
  }

  const session = data.data?.session;
  if (!session?.id) {
    throw new Error(`Unexpected session response shape: ${JSON.stringify(data)}`);
  }

  return {
    id: session.id,
    status: session.status,
    streamUrl: `/ws/stream/${session.id}?format=h264`,
  };
}

// ---------------------------------------------------------------------------
// Interaction sender
// ---------------------------------------------------------------------------

/** Index of the next interaction to send from {@link INTERACTION_SEQUENCE}. */
let interactionIndex = 0;

/**
 * Send the next interaction in the cycle over the WebSocket and advance the
 * interaction index.
 *
 * Tap message format:
 *   { type, action: 'tap', x, y, deviceX, deviceY }
 *
 * Swipe message format:
 *   { type, action: 'swipe', startX, startY, endX, endY,
 *     deviceStartX, deviceStartY, deviceEndX, deviceEndY }
 *
 * @param {WebSocket} ws - The open WebSocket connection to the stream endpoint.
 */
function sendNextInteraction(ws) {
  if (ws.readyState !== ws.OPEN) return;

  const interaction = INTERACTION_SEQUENCE[interactionIndex % INTERACTION_SEQUENCE.length];
  interactionIndex += 1;

  if (interaction.kind === 'tap') {
    const msg = {
      type: 'touch',
      action: 'tap',
      x: interaction.x,
      y: interaction.y,
      deviceX: interaction.deviceX,
      deviceY: interaction.deviceY,
    };
    ws.send(JSON.stringify(msg));
    log(`[interaction] Tap at (${interaction.x}, ${interaction.y})`);
  } else {
    const msg = {
      type: 'touch',
      action: 'swipe',
      startX: interaction.startX,
      startY: interaction.startY,
      endX: interaction.endX,
      endY: interaction.endY,
      deviceStartX: interaction.deviceStartX,
      deviceStartY: interaction.deviceStartY,
      deviceEndX: interaction.deviceEndX,
      deviceEndY: interaction.deviceEndY,
    };
    ws.send(JSON.stringify(msg));
    log(`[interaction] Swipe from (${interaction.startX}, ${interaction.startY}) to (${interaction.endX}, ${interaction.endY})`);
  }
}

// ---------------------------------------------------------------------------
// Step 5 — Connect to the H.264 WebSocket
// ---------------------------------------------------------------------------

/**
 * Connect to the H.264 WebSocket stream endpoint and start writing NALU data
 * to the .h264 file.  Sets up auto-termination after {@link CAPTURE_DURATION_S}
 * seconds of actual frames.
 *
 * Binary message layout (from ws-stream.ts):
 *   [1 byte: flags (bit 0 = isKeyframe)]
 *   [8 bytes BE: timestamp in microseconds]
 *   [remaining: raw Annex-B NALU data]
 *
 * @param {string} sid - The session ID.
 * @returns {Promise<WebSocket>} Resolves once the WebSocket is open.
 */
function connectH264WebSocket(sid) {
  return new Promise((resolve, reject) => {
    const wsUrl = `ws://localhost:3000/ws/stream/${sid}?format=h264`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      log('[5/7] WebSocket connected.');
      resolve(ws);
    });

    ws.on('error', (err) => {
      if (!cleaningUp) {
        log(`\n❌ WebSocket error: ${err.message}`);
        cleanup().catch(() => process.exit(1));
      }
      reject(err);
    });

    ws.on('close', (code, reason) => {
      if (!cleaningUp) {
        const reasonStr = reason ? reason.toString() : 'no reason';
        log(`\n❌ WebSocket closed unexpectedly (code=${code}, reason=${reasonStr})`);
        cleanup().catch(() => process.exit(1));
      }
    });

    ws.on('message', (data) => {
      // data is a Buffer (binary message)
      if (!Buffer.isBuffer(data)) return;
      if (data.length < 9) return; // Too small to have the header

      // Parse the 9-byte header
      const flags = data[0];
      const isKeyframe = (flags & 0x01) === 1;

      // Bytes 1–8: 64-bit big-endian timestamp (microseconds) — read as two
      // 32-bit halves because Node 20 BigInt is available but we only need
      // the timestamp for display purposes.
      const timestampHi = data.readUInt32BE(1);
      const timestampLo = data.readUInt32BE(5);
      const timestampUs = timestampHi * 4294967296 + timestampLo; // approx µs

      // Raw Annex-B NALU data starts at byte 9
      const naluData = data.slice(9);
      const naluSize = naluData.length;

      // Start the capture clock on the very first frame
      if (firstFrameMs === 0) {
        firstFrameMs = Date.now();
        log(`[6/7] First H.264 frame received — capture started (will auto-stop after ${CAPTURE_DURATION_S}s).`);

        // Start interaction timer now that frames are arriving
        interactionInterval = setInterval(() => {
          sendNextInteraction(ws);
        }, INTERACTION_INTERVAL_MS);

        // Auto-termination timer: fires after CAPTURE_DURATION_S seconds
        setTimeout(() => {
          log(`\n[7/7] Capture duration (${CAPTURE_DURATION_S}s) reached — stopping capture.`);
          autoTerminate();
        }, CAPTURE_DURATION_S * 1000);
      }

      // Update statistics
      totalFrames += 1;
      windowFrames += 1;
      totalBytes += naluSize;
      windowBytes += naluSize;

      if (isKeyframe) {
        totalKeyframes += 1;
        windowKeyframes += 1;
        const elapsedS = ((Date.now() - firstFrameMs) / 1000).toFixed(1);
        log(`[keyframe] #${totalKeyframes} at +${elapsedS}s, size: ${fmt(naluSize)} bytes`);
      }

      // Write the raw Annex-B NALU data to the diagnostic file
      if (h264FileStream !== null) {
        h264FileStream.write(naluData);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Stats printer
// ---------------------------------------------------------------------------

/**
 * Start the periodic statistics printer that fires every
 * {@link STATS_INTERVAL_MS} milliseconds.
 */
function startStatsInterval() {
  let windowIndex = 0;

  statsInterval = setInterval(() => {
    windowIndex += 1;
    const elapsedS = firstFrameMs > 0
      ? ((Date.now() - firstFrameMs) / 1000).toFixed(1)
      : `${windowIndex * (STATS_INTERVAL_MS / 1000)}`;
    const windowPFrames = windowFrames - windowKeyframes;
    const avgSize = windowFrames > 0 ? Math.round(windowBytes / windowFrames) : 0;
    const fps = (windowFrames / (STATS_INTERVAL_MS / 1000)).toFixed(1);

    log(
      `[stats] ${elapsedS}s: ${windowFrames} frames ` +
        `(${windowKeyframes} keyframes, ${windowPFrames} P-frames), ` +
        `avg ${fmt(avgSize)} bytes, ~${fps} fps`,
    );

    // Reset the window counters
    windowFrames = 0;
    windowKeyframes = 0;
    windowBytes = 0;
  }, STATS_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Step 7 — Auto-termination: convert .h264 → .mp4, inspect, open
// ---------------------------------------------------------------------------

/** Whether auto-termination has already been triggered. */
let autoTerminating = false;

/**
 * Perform the post-capture pipeline:
 *   1. Stop interaction and stats timers
 *   2. Flush and close the .h264 file stream
 *   3. Run ffmpeg to produce a .mp4
 *   4. Run ffprobe on the .mp4
 *   5. Open the .mp4 with `open` (macOS)
 *   6. Invoke cleanup (delete session, kill server)
 *
 * @returns {Promise<void>}
 */
async function autoTerminate() {
  if (autoTerminating) return;
  autoTerminating = true;

  // Stop interaction and stats timers
  if (interactionInterval !== null) {
    clearInterval(interactionInterval);
    interactionInterval = null;
  }
  if (statsInterval !== null) {
    clearInterval(statsInterval);
    statsInterval = null;
  }

  // Close the WebSocket (stop more frames arriving)
  if (streamSocket !== null) {
    try {
      streamSocket.close();
    } catch {
      // Ignore
    }
    streamSocket = null;
  }

  // Flush and close the .h264 file
  if (h264FileStream !== null) {
    await new Promise((resolve) => h264FileStream.end(resolve));
    try {
      const stats = fs.statSync(H264_FILE_PATH);
      log(`   H.264 file saved: ${H264_FILE_PATH} (${fmt(stats.size)} bytes)`);
    } catch {
      log(`   Warning: could not stat ${H264_FILE_PATH}`);
    }
    h264FileStream = null;
  }

  // Convert .h264 → .mp4 using ffmpeg
  log('\n[7/7] Converting .h264 → .mp4 via ffmpeg...');
  try {
    execFileSync('ffmpeg', [
      '-y',
      '-fflags', '+genpts',
      '-f', 'h264',
      '-r', '30',
      '-i', H264_FILE_PATH,
      '-c', 'copy',
      '-video_track_timescale', '30',
      '-movflags', '+faststart',
      MP4_FILE_PATH,
    ], { stdio: 'inherit' });
    log(`   MP4 written: ${MP4_FILE_PATH}`);
  } catch (err) {
    log(`   ❌ ffmpeg failed: ${err.message}`);
  }

  // Run ffprobe on the .mp4 to log stream info
  log('\n[7/7] Running ffprobe on the .mp4...');
  try {
    execFileSync('ffprobe', [MP4_FILE_PATH], { stdio: 'inherit' });
  } catch {
    // ffprobe exits non-zero when printing to stderr — that's normal
    // The output is inherited so the user can see it regardless
  }

  // Open the .mp4 for visual inspection (macOS)
  log('\n[7/7] Opening .mp4 for visual inspection...');
  try {
    execFileSync('open', [MP4_FILE_PATH]);
    log(`   Opened: ${MP4_FILE_PATH}`);
  } catch (err) {
    log(`   Warning: could not open .mp4 — ${err.message}`);
  }

  // Delegate session deletion + server kill to cleanup()
  await cleanup();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Orchestrate all steps of the test script.
 *
 * @returns {Promise<void>}
 */
async function main() {
  console.log('🎬 H.264 Stream Test Script');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ------------------------------------------------------------------
  // Step 1: Start the API server
  // ------------------------------------------------------------------
  log('[1/7] Starting API server...');
  serverProcess = startApiServer();

  // ------------------------------------------------------------------
  // Step 2: Wait for the server to be ready
  // ------------------------------------------------------------------
  log('[2/7] Waiting for server to be ready...');
  await waitForServer();
  log('[2/7] Server is ready.');

  // ------------------------------------------------------------------
  // Step 3: Create iOS session
  // ------------------------------------------------------------------
  log('[3/7] Creating iOS session...');
  const session = await createIosSession();
  sessionId = session.id;
  log(`[3/7] Session created: ${sessionId}`);
  log(`[3/7] Stream URL: ${session.streamUrl}`);

  // ------------------------------------------------------------------
  // Step 4: Wait for simulator boot + capture binary startup
  // ------------------------------------------------------------------
  const bootWaitS = SIMULATOR_BOOT_WAIT_MS / 1000;
  log(`[4/7] Waiting ${bootWaitS}s for simulator boot...`);
  for (let remaining = bootWaitS; remaining > 0; remaining -= 5) {
    await sleep(Math.min(5000, remaining * 1000));
    if (remaining > 5) {
      log(`[4/7]   ${remaining - 5}s remaining...`);
    }
  }

  // ------------------------------------------------------------------
  // Step 5: Connect H.264 WebSocket + open .h264 file
  // ------------------------------------------------------------------
  log('[5/7] Connecting to H.264 WebSocket stream...');
  h264FileStream = fs.createWriteStream(H264_FILE_PATH, { flags: 'w' });
  log(`   Saving raw Annex-B NALUs to: ${H264_FILE_PATH}`);

  streamSocket = await connectH264WebSocket(sessionId);

  // ------------------------------------------------------------------
  // Step 6: Capture with interactions + periodic stats
  // ------------------------------------------------------------------
  console.log('');
  console.log(`📁 H.264 file output: ${H264_FILE_PATH}`);
  console.log(`📹 MP4 output will be: ${MP4_FILE_PATH}`);
  console.log(`⏱  Auto-terminating after ${CAPTURE_DURATION_S}s of frames`);
  console.log(`🕹  Sending interactions every ${INTERACTION_INTERVAL_MS / 1000}s`);
  console.log('');
  console.log('Waiting for H.264 frames...');
  console.log('');
  console.log('Press Ctrl+C to stop early and clean up.');
  console.log('');

  // ------------------------------------------------------------------
  // Start periodic stats printer (fires during step 6)
  // ------------------------------------------------------------------
  startStatsInterval();
}

// Run
main().catch(async (err) => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  await cleanup();
  process.exit(1);
});
