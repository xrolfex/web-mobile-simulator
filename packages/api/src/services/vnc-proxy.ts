import { WebSocketServer, WebSocket } from 'ws';
import { createConnection, createServer, Socket } from 'node:net';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single paired WebSocket + TCP connection belonging to a proxy instance. */
interface ProxyConnection {
  ws: WebSocket;
  tcp: Socket;
}

/** State for one active VNC proxy (one per session). */
interface ProxyInstance {
  /** WebSocket server listening for browser connections. */
  wss: WebSocketServer;
  /** The port the WebSocket server is listening on. */
  wsPort: number;
  /** VNC target hostname (usually '127.0.0.1'). */
  targetHost: string;
  /** VNC target TCP port (usually 5900). */
  targetPort: number;
  /** All currently active paired connections for this proxy. */
  connections: Set<ProxyConnection>;
  /** Session ID this proxy belongs to. */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Module-level helpers (mirrors ios-simulator.ts / android-emulator.ts style)
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[VNCProxyService]';

/** Emit a prefixed log line to stdout. */
function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** Emit a prefixed warning to stderr. */
function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * Manages a pool of native Node.js WebSocket-to-TCP proxy servers, one per
 * active session.  Each proxy bridges a browser's WebSocket connection (used
 * by noVNC) to the VNC TCP server that the iOS Simulator or Android Emulator
 * is listening on.
 *
 * Port allocation draws from the configured range (`config.vncProxyPortRange`,
 * defaulting to 6900–6999).
 *
 * Export the singleton `vncProxyService` rather than constructing instances.
 */
export class VNCProxyService {
  /** Active proxy instances keyed by session ID. */
  private readonly proxies = new Map<string, ProxyInstance>();

  /** Track which ports in the configured range are currently occupied. */
  private readonly usedPorts = new Set<number>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start a new VNC proxy for the given session.
   *
   * Creates a WebSocket server that bridges incoming browser WebSocket
   * connections to the VNC TCP server at `vncHost:vncPort`.  If a proxy
   * already exists for `sessionId`, the existing WebSocket URL is returned
   * immediately without creating a second server.
   *
   * @param sessionId - Unique session identifier.
   * @param vncHost   - VNC server hostname (usually `'127.0.0.1'`).
   * @param vncPort   - VNC server TCP port (usually `5900`).
   * @returns The allocated WebSocket port and a `ws://` URL for the browser.
   */
  async startProxy(
    sessionId: string,
    vncHost: string,
    vncPort: number,
  ): Promise<{ wsPort: number; wsUrl: string }> {
    // Return immediately if a proxy is already running for this session.
    const existing = this.proxies.get(sessionId);
    if (existing) {
      log(`Proxy already running for session ${sessionId} on port ${existing.wsPort}`);
      return {
        wsPort: existing.wsPort,
        wsUrl: `ws://localhost:${existing.wsPort}`,
      };
    }

    const wsPort = await this.findAvailablePort();
    const connections = new Set<ProxyConnection>();

    // Create the WebSocket server and wait until it is actually listening
    // before we declare success, so callers can immediately hand the URL to
    // the browser.
    const wss = await new Promise<WebSocketServer>((resolve, reject) => {
      const server = new WebSocketServer({ port: wsPort });
      server.once('listening', () => resolve(server));
      server.once('error', reject);
    });

    const proxy: ProxyInstance = {
      wss,
      wsPort,
      targetHost: vncHost,
      targetPort: vncPort,
      connections,
      sessionId,
    };

    this.proxies.set(sessionId, proxy);
    this.usedPorts.add(wsPort);

    // Wire up connection handling.
    wss.on('connection', (ws: WebSocket) => {
      this.handleBrowserConnection(proxy, ws);
    });

    wss.on('error', (err: Error) => {
      warn(`WebSocket server error for session ${sessionId}: ${err.message}`);
    });

    log(
      `Started proxy for session ${sessionId}: ` +
        `ws://localhost:${wsPort} → ${vncHost}:${vncPort}`,
    );

    return { wsPort, wsUrl: `ws://localhost:${wsPort}` };
  }

  /**
   * Stop the VNC proxy for `sessionId`.
   *
   * Destroys all active TCP sockets, closes all WebSocket connections, and
   * then closes the WebSocket server itself.  Does nothing if no proxy exists
   * for the given session.
   *
   * @param sessionId - Session whose proxy should be torn down.
   */
  async stopProxy(sessionId: string): Promise<void> {
    const proxy = this.proxies.get(sessionId);
    if (!proxy) return;

    // Tear down every active paired connection.
    for (const conn of proxy.connections) {
      conn.tcp.destroy();
      conn.ws.close();
    }
    proxy.connections.clear();

    // Close the WebSocket server and await confirmation.
    await new Promise<void>((resolve, reject) => {
      proxy.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this.usedPorts.delete(proxy.wsPort);
    this.proxies.delete(sessionId);

    log(`Stopped proxy for session ${sessionId}`);
  }

  /**
   * Stop **all** active proxies.
   *
   * Intended for graceful server shutdown.  Uses `Promise.allSettled` so a
   * single failing stop does not prevent the others from running.
   */
  async cleanup(): Promise<void> {
    const sessionIds = [...this.proxies.keys()];
    await Promise.allSettled(sessionIds.map((id) => this.stopProxy(id)));
    log('All proxies cleaned up');
  }

  /**
   * Return the WebSocket port and URL for a running proxy, or `null` if no
   * proxy exists for `sessionId`.
   *
   * @param sessionId - Session to look up.
   */
  getProxy(sessionId: string): { wsPort: number; wsUrl: string } | null {
    const proxy = this.proxies.get(sessionId);
    if (!proxy) return null;
    return { wsPort: proxy.wsPort, wsUrl: `ws://localhost:${proxy.wsPort}` };
  }

  /**
   * Return the number of currently active proxy instances.
   */
  getActiveCount(): number {
    return this.proxies.size;
  }

  // -------------------------------------------------------------------------
  // Private — connection bridging
  // -------------------------------------------------------------------------

  /**
   * Set up bidirectional bridging between a newly connected browser WebSocket
   * and a fresh TCP connection to the VNC server.
   *
   * Data flow:
   * - Browser → WebSocket message → TCP write  (to VNC server)
   * - VNC server → TCP data → WebSocket send   (to browser)
   *
   * Either side disconnecting or erroring causes the other side to be closed
   * and the connection pair to be removed from the tracking set.
   *
   * @param proxy - The proxy instance this connection belongs to.
   * @param ws    - The incoming browser WebSocket connection.
   */
  private handleBrowserConnection(proxy: ProxyInstance, ws: WebSocket): void {
    const { sessionId, targetHost, targetPort, connections } = proxy;

    log(`Browser connected to session ${sessionId} on port ${proxy.wsPort}`);

    // Open a TCP connection to the VNC server.
    const tcp = createConnection({ host: targetHost, port: targetPort }, () => {
      log(`TCP connection established to ${targetHost}:${targetPort} for session ${sessionId}`);
    });

    const conn: ProxyConnection = { ws, tcp };
    connections.add(conn);

    // ---- WebSocket → TCP (browser → VNC server) ---------------------------
    ws.on('message', (data: Buffer) => {
      if (tcp.writable) {
        tcp.write(data);
      }
    });

    // ---- TCP → WebSocket (VNC server → browser) ---------------------------
    tcp.on('data', (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // ---- WebSocket close / error ------------------------------------------
    ws.on('close', () => {
      log(`Browser disconnected from session ${sessionId}`);
      tcp.destroy();
      connections.delete(conn);
    });

    ws.on('error', (err: Error) => {
      warn(`WebSocket error for session ${sessionId}: ${err.message}`);
      tcp.destroy();
      connections.delete(conn);
    });

    // ---- TCP close / error ------------------------------------------------
    tcp.on('close', () => {
      log(`VNC server disconnected for session ${sessionId}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      connections.delete(conn);
    });

    tcp.on('error', (err: Error) => {
      warn(`TCP error for session ${sessionId}: ${err.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'VNC server connection failed');
      }
      connections.delete(conn);
    });
  }

  // -------------------------------------------------------------------------
  // Private — port allocation
  // -------------------------------------------------------------------------

  /**
   * Find the first port in the configured VNC proxy range that is both
   * untracked by this service and actually free on the OS.
   *
   * @throws If no port is available in the entire configured range.
   */
  private async findAvailablePort(): Promise<number> {
    const { start, end } = config.vncProxyPortRange;

    for (let port = start; port <= end; port++) {
      if (this.usedPorts.has(port)) continue;

      const free = await this.isPortFree(port);
      if (free) return port;
    }

    throw new Error(
      `No available ports in range ${start}–${end}. ` +
        `All ${end - start + 1} proxy slots are in use.`,
    );
  }

  /**
   * Probe whether `port` is free by briefly binding a TCP server to it.
   *
   * Resolves `true` if the port can be bound (and immediately releases it),
   * `false` if the OS reports the port is already in use.
   *
   * @param port - Port number to probe.
   */
  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => {
        probe.close(() => resolve(true));
      });
      probe.listen(port, '0.0.0.0');
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton instance — import this rather than constructing directly. */
export const vncProxyService = new VNCProxyService();
