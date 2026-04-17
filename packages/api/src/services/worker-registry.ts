import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  WorkerNode,
  WorkerCapacity,
  WorkerRegistrationRequest,
  WorkerRegistrationResponse,
  WorkerHeartbeatRequest,
  Platform,
} from '@web-mobile-simulator/shared';
import {
  DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_OFFLINE_THRESHOLD_MS,
} from '@web-mobile-simulator/shared';
import { eventBusService } from './event-bus.js';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[WorkerRegistryService]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Extended internal record with the event-aggregation WebSocket. */
interface InternalWorkerNode extends WorkerNode {
  /** Active WebSocket connection to this worker's /ws/events endpoint, or null. */
  _eventsSocket: WebSocket | null;
  /** Number of event-aggregation reconnect attempts made so far. */
  _eventsReconnectAttempts: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Manages the registry of connected worker nodes on the master.
 *
 * Responsibilities:
 * - Accept worker registrations and assign stable UUIDs.
 * - Track capacity via periodic heartbeats.
 * - Mark workers offline when heartbeats stop arriving.
 * - Select the best available worker for a new session (least-loaded).
 * - Aggregate worker event streams into the local event bus.
 *
 * Export the singleton `workerRegistryService` rather than constructing
 * instances directly.
 */
export class WorkerRegistryService {
  /** In-memory worker store keyed by workerId. */
  private readonly workers = new Map<string, InternalWorkerNode>();

  /** Handle for the periodic health-check interval. */
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a new worker node. Assigns a UUID, stores capacity, and starts
   * aggregating its event stream.
   *
   * @param req - Registration payload from the worker.
   * @returns Response containing the assigned workerId and heartbeat interval.
   */
  registerWorker(req: WorkerRegistrationRequest): WorkerRegistrationResponse {
    const workerId = randomUUID();
    const registeredAt = now();

    const capacity: WorkerCapacity = {
      maxIosSessions: req.maxIosSessions,
      maxAndroidSessions: req.maxAndroidSessions,
      currentIosSessions: 0,
      currentAndroidSessions: 0,
    };

    const worker: InternalWorkerNode = {
      id: workerId,
      url: req.url,
      capacity,
      lastHeartbeatAt: registeredAt,
      isHealthy: true,
      registeredAt,
      _eventsSocket: null,
      _eventsReconnectAttempts: 0,
    };

    this.workers.set(workerId, worker);
    log(`Worker registered: ${workerId} at ${req.url} (iOS max=${req.maxIosSessions}, Android max=${req.maxAndroidSessions})`);

    // Start aggregating this worker's event stream.
    this.connectWorkerEvents(worker);

    return {
      workerId,
      heartbeatIntervalMs: DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
    };
  }

  /**
   * Update a worker's heartbeat timestamp and current session counts.
   *
   * @param workerId - The worker's UUID.
   * @param req      - Current session counts from the worker.
   * @returns `true` if the worker was found and updated; `false` otherwise.
   */
  updateHeartbeat(workerId: string, req: WorkerHeartbeatRequest): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    worker.lastHeartbeatAt = now();
    worker.isHealthy = true;
    worker.capacity.currentIosSessions = req.currentIosSessions;
    worker.capacity.currentAndroidSessions = req.currentAndroidSessions;

    return true;
  }

  /**
   * Mark a worker as unhealthy (e.g. heartbeat timeout or explicit removal).
   *
   * @param workerId - The worker's UUID.
   */
  markOffline(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    if (worker.isHealthy) {
      warn(`Worker ${workerId} (${worker.url}) marked offline.`);
    }

    worker.isHealthy = false;

    // Close the event aggregation socket if open.
    if (worker._eventsSocket !== null) {
      try {
        worker._eventsSocket.close();
      } catch {
        // Ignore close errors.
      }
      worker._eventsSocket = null;
    }
  }

  /**
   * Remove a worker from the registry entirely (e.g. clean deregistration).
   *
   * @param workerId - The worker's UUID.
   */
  removeWorker(workerId: string): void {
    this.markOffline(workerId);
    this.workers.delete(workerId);
    log(`Worker ${workerId} removed from registry.`);
  }

  /**
   * Return all registered workers (healthy and unhealthy).
   *
   * @returns Snapshot array of all `WorkerNode` records.
   */
  getAllWorkers(): WorkerNode[] {
    return [...this.workers.values()].map((w) => this.toPublic(w));
  }

  /**
   * Return only healthy (recently-heartbeating) workers.
   *
   * @returns Array of healthy `WorkerNode` records.
   */
  getHealthyWorkers(): WorkerNode[] {
    return [...this.workers.values()]
      .filter((w) => w.isHealthy)
      .map((w) => this.toPublic(w));
  }

  /**
   * Look up a worker by ID.
   *
   * @param workerId - The worker's UUID.
   * @returns The `WorkerNode`, or `null` if not found.
   */
  getWorker(workerId: string): WorkerNode | null {
    const w = this.workers.get(workerId);
    return w ? this.toPublic(w) : null;
  }

  /**
   * Select the best available worker for a new session on the given platform.
   *
   * Strategy: among healthy workers with remaining capacity for the requested
   * platform, prefer the worker with the lowest total active session count
   * (iOS + Android) — i.e., the least-loaded worker overall.
   *
   * @param platform - `'ios'` or `'android'`.
   * @returns The selected `WorkerNode`, or `null` if no worker can accept the session.
   */
  pickWorker(platform: Platform): WorkerNode | null {
    const candidates = [...this.workers.values()].filter((w) => {
      if (!w.isHealthy) return false;

      if (platform === 'ios') {
        return w.capacity.currentIosSessions < w.capacity.maxIosSessions;
      } else {
        return w.capacity.currentAndroidSessions < w.capacity.maxAndroidSessions;
      }
    });

    if (candidates.length === 0) return null;

    // Least-loaded by total active sessions.
    candidates.sort((a, b) => {
      const totalA = a.capacity.currentIosSessions + a.capacity.currentAndroidSessions;
      const totalB = b.capacity.currentIosSessions + b.capacity.currentAndroidSessions;
      return totalA - totalB;
    });

    return this.toPublic(candidates[0]!);
  }

  /**
   * Start the periodic health-check interval.
   *
   * Should be called once during master-mode startup. Checks all workers
   * every 30 seconds and marks those with stale heartbeats as offline.
   */
  startHealthCheckInterval(): void {
    if (this.healthCheckInterval !== null) return;

    this.healthCheckInterval = setInterval(() => {
      this.runHealthCheck();
    }, 30_000);

    log('Health-check interval started (every 30 s).');
  }

  /**
   * Stop the health-check interval and close all event aggregation sockets.
   * Called during graceful shutdown.
   */
  stop(): void {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    for (const worker of this.workers.values()) {
      if (worker._eventsSocket !== null) {
        try {
          worker._eventsSocket.close();
        } catch {
          // Ignore.
        }
        worker._eventsSocket = null;
      }
    }

    log('WorkerRegistryService stopped.');
  }

  // -------------------------------------------------------------------------
  // Private — health checking
  // -------------------------------------------------------------------------

  /**
   * Mark workers whose last heartbeat is older than `WORKER_OFFLINE_THRESHOLD_MS`
   * as offline.
   */
  private runHealthCheck(): void {
    const cutoff = Date.now() - WORKER_OFFLINE_THRESHOLD_MS;

    for (const worker of this.workers.values()) {
      if (!worker.isHealthy) continue;

      const lastBeat = new Date(worker.lastHeartbeatAt).getTime();
      if (lastBeat < cutoff) {
        warn(
          `Worker ${worker.id} (${worker.url}) missed heartbeat — ` +
          `last seen ${Math.round((Date.now() - lastBeat) / 1000)} s ago.`,
        );
        this.markOffline(worker.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private — event aggregation
  // -------------------------------------------------------------------------

  /**
   * Open a WebSocket connection to the worker's `/ws/events` endpoint and
   * forward all received messages onto the local `eventBusService`.
   *
   * On unexpected close or error, schedules a reconnect with up to 5 attempts
   * (5-second fixed delay).  Stops retrying if the worker is marked offline.
   *
   * @param worker - The internal worker record to connect.
   */
  private connectWorkerEvents(worker: InternalWorkerNode): void {
    if (!worker.isHealthy) return;

    const url = `${worker.url.replace(/^http/, 'ws')}/ws/events`;
    log(`Connecting to worker event stream: ${url}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err: unknown) {
      warn(`Failed to create WebSocket for worker ${worker.id}: ${String(err)}`);
      this.scheduleEventsReconnect(worker);
      return;
    }

    worker._eventsSocket = ws;

    ws.on('open', () => {
      log(`Worker event stream connected: ${worker.id} (${url})`);
      worker._eventsReconnectAttempts = 0;
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type: string;
          payload: unknown;
          timestamp: string;
        };

        // Re-emit the event on the local bus so master's /ws/events clients
        // receive events from all workers transparently.
        eventBusService.emit(
          message.type as Parameters<typeof eventBusService.emit>[0],
          message.payload,
        );
      } catch {
        // Silently ignore unparseable messages.
      }
    });

    ws.on('close', () => {
      log(`Worker event stream closed: ${worker.id}`);
      worker._eventsSocket = null;
      this.scheduleEventsReconnect(worker);
    });

    ws.on('error', (err: Error) => {
      warn(`Worker event stream error for ${worker.id}: ${err.message}`);
      // 'close' will fire after 'error', so reconnect is handled there.
    });
  }

  /**
   * Schedule a reconnect attempt for the event aggregation WebSocket.
   * Gives up after 5 attempts. Does not retry if the worker is offline.
   *
   * @param worker - The worker whose event stream should be reconnected.
   */
  private scheduleEventsReconnect(worker: InternalWorkerNode): void {
    if (!worker.isHealthy) return;

    const MAX_ATTEMPTS = 5;
    if (worker._eventsReconnectAttempts >= MAX_ATTEMPTS) {
      warn(
        `Giving up on event stream for worker ${worker.id} after ` +
        `${MAX_ATTEMPTS} attempts.`,
      );
      return;
    }

    worker._eventsReconnectAttempts++;
    const delay = 5_000;

    log(
      `Scheduling event stream reconnect for worker ${worker.id} ` +
      `(attempt ${worker._eventsReconnectAttempts}/${MAX_ATTEMPTS}) in ${delay}ms`,
    );

    setTimeout(() => {
      if (worker.isHealthy && this.workers.has(worker.id)) {
        this.connectWorkerEvents(worker);
      }
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Private — helpers
  // -------------------------------------------------------------------------

  /**
   * Strip internal fields (`_eventsSocket`, `_eventsReconnectAttempts`) before
   * returning a `WorkerNode` to callers.
   */
  private toPublic(worker: InternalWorkerNode): WorkerNode {
    return {
      id: worker.id,
      url: worker.url,
      capacity: { ...worker.capacity },
      lastHeartbeatAt: worker.lastHeartbeatAt,
      isHealthy: worker.isHealthy,
      registeredAt: worker.registeredAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton — import this rather than constructing directly. */
export const workerRegistryService = new WorkerRegistryService();
