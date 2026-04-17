import { config } from '../config.js';
import { sessionManagerService } from './session-manager.js';
import type {
  WorkerRegistrationRequest,
  WorkerRegistrationResponse,
  WorkerHeartbeatRequest,
} from '@web-mobile-simulator/shared';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[WorkerRegistrationService]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} WARN  ${message}`);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Manages a worker node's registration with the master and the periodic
 * heartbeat that keeps the worker marked as healthy.
 *
 * This service is only active when `config.nodeMode === 'worker'`.
 *
 * Lifecycle:
 *   1. `startRegistration()` — called after the Fastify server starts listening.
 *      Registers with master (with retry), then begins the heartbeat loop.
 *   2. `stopRegistration()` — called during graceful shutdown.
 *      Clears the heartbeat interval; attempts a best-effort deregistration.
 *
 * Export the singleton `workerRegistrationService` rather than constructing
 * instances directly.
 */
export class WorkerRegistrationService {
  /** UUID assigned by the master at registration time. */
  private workerId: string | null = null;

  /** Handle for the periodic heartbeat interval. */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** When true, `stopRegistration()` has been called; suppress further retries. */
  private stopped = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register this worker with the master and start the heartbeat loop.
   *
   * Retries up to 10 times with exponential backoff (1 s → 2 s → 4 s … capped
   * at 30 s) if the master is unreachable.  If all attempts fail the method
   * resolves without throwing — the worker continues to operate in a degraded
   * (unregistered) mode and logs a warning.
   *
   * This method is safe to call multiple times; subsequent calls are no-ops if
   * already registered.
   */
  async startRegistration(): Promise<void> {
    if (this.workerId !== null) {
      log('Already registered — skipping.');
      return;
    }

    if (this.stopped) return;

    // Validate required config before attempting.
    if (!config.masterUrl) {
      warn('MASTER_URL is not set. Worker will operate without master registration.');
      return;
    }
    if (!config.workerPublicUrl) {
      warn('WORKER_PUBLIC_URL is not set. Worker cannot register with master.');
      return;
    }
    if (!config.workerSecret) {
      warn('WORKER_SECRET is not set. Worker cannot authenticate with master.');
      return;
    }

    const registrationBody: WorkerRegistrationRequest = {
      url: config.workerPublicUrl,
      maxIosSessions: config.workerMaxIosSessions,
      maxAndroidSessions: config.workerMaxAndroidSessions,
      secret: config.workerSecret,
    };

    log(
      `Registering with master at ${config.masterUrl} ` +
      `(publicUrl=${config.workerPublicUrl}, ` +
      `maxIos=${config.workerMaxIosSessions}, maxAndroid=${config.workerMaxAndroidSessions})`,
    );

    const MAX_ATTEMPTS = 10;
    const BASE_DELAY_MS = 1_000;
    const MAX_DELAY_MS = 30_000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.stopped) return;

      try {
        const response = await fetch(
          `${config.masterUrl}/internal/workers/register`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.workerSecret}`,
            },
            body: JSON.stringify(registrationBody),
          },
        );

        if (!response.ok) {
          const text = await response.text().catch(() => '(unreadable)');
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const data = await response.json() as WorkerRegistrationResponse;
        this.workerId = data.workerId;

        log(`Registered with master — workerId=${this.workerId}`);

        // Start the heartbeat loop using the interval advised by the master.
        this.startHeartbeatLoop(data.heartbeatIntervalMs);
        return;

      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isLastAttempt = attempt === MAX_ATTEMPTS;

        if (isLastAttempt) {
          warn(
            `Registration failed after ${MAX_ATTEMPTS} attempts. ` +
            `Worker will operate without master registration. Last error: ${errMsg}`,
          );
          return;
        }

        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
        warn(
          `Registration attempt ${attempt}/${MAX_ATTEMPTS} failed: ${errMsg}. ` +
          `Retrying in ${delay}ms…`,
        );
        await sleep(delay);
      }
    }
  }

  /**
   * Stop the heartbeat interval and attempt a graceful deregistration.
   *
   * Errors from the deregistration call are swallowed — shutdown must not block.
   */
  stopRegistration(): void {
    this.stopped = true;

    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    log('Worker registration stopped.');
  }

  /**
   * Returns the workerId assigned by the master, or `null` if not yet
   * registered.
   */
  getWorkerId(): string | null {
    return this.workerId;
  }

  // -------------------------------------------------------------------------
  // Private — heartbeat
  // -------------------------------------------------------------------------

  /**
   * Start the periodic heartbeat loop at the given interval.
   *
   * @param intervalMs - How often (ms) to send a heartbeat to the master.
   */
  private startHeartbeatLoop(intervalMs: number): void {
    if (this.heartbeatInterval !== null) return;

    log(`Starting heartbeat loop (every ${intervalMs}ms)`);

    this.heartbeatInterval = setInterval(() => {
      void this.sendHeartbeat();
    }, intervalMs);
  }

  /**
   * Send a single heartbeat to the master, reporting current session counts.
   *
   * Errors are logged but never thrown.
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.workerId || !config.masterUrl || this.stopped) return;

    const capacity = sessionManagerService.getCapacityInfo();

    const body: WorkerHeartbeatRequest = {
      currentIosSessions: capacity.perPlatform['ios']?.active ?? 0,
      currentAndroidSessions: capacity.perPlatform['android']?.active ?? 0,
    };

    try {
      const response = await fetch(
        `${config.masterUrl}/internal/workers/${this.workerId}/heartbeat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.workerSecret}`,
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '(unreadable)');
        warn(`Heartbeat returned HTTP ${response.status}: ${text}`);
      }
    } catch (err: unknown) {
      warn(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Shared singleton — import this rather than constructing directly. */
export const workerRegistrationService = new WorkerRegistrationService();
