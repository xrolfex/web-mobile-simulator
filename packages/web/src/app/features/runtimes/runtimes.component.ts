import {
  Component,
  OnInit,
  signal,
  computed,
  inject,
} from '@angular/core';

import { ApiService } from '../../core/services/api.service';
import type { Runtime } from '../../core/types/api.types';

/** IDs of runtimes currently being downloaded (in-flight). */
type DownloadingSet = Set<string>;

/**
 * Runtimes management page component.
 *
 * Fetches iOS and Android runtime versions from the API and lets the user
 * trigger downloads for runtimes that are not yet installed.
 */
@Component({
  selector: 'app-runtimes',
  standalone: true,
  imports: [],
  templateUrl: './runtimes.component.html',
  styleUrl: './runtimes.component.scss',
})
export class RuntimesComponent implements OnInit {
  /** Currently active platform tab. */
  protected readonly activeTab = signal<'ios' | 'android'>('ios');

  /** All iOS runtimes fetched from the API. */
  protected readonly iosRuntimes = signal<Runtime[]>([]);

  /** All Android runtimes fetched from the API. */
  protected readonly androidRuntimes = signal<Runtime[]>([]);

  /** Whether the runtimes list is loading. */
  protected readonly loading = signal<boolean>(true);

  /** API error message; empty when no error. */
  protected readonly errorMessage = signal<string>('');

  /** Set of runtime identifiers that have a download request in-flight. */
  protected readonly downloadingIds = signal<DownloadingSet>(new Set());

  /** Runtimes for the currently active tab. */
  protected readonly currentRuntimes = computed<Runtime[]>(() =>
    this.activeTab() === 'ios' ? this.iosRuntimes() : this.androidRuntimes(),
  );

  private readonly api = inject(ApiService);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.loadRuntimes();
  }

  // ── Template event handlers ──────────────────────────────────────────────

  /**
   * Switch the active platform tab.
   * @param tab The platform tab to activate.
   */
  protected selectTab(tab: 'ios' | 'android'): void {
    this.activeTab.set(tab);
  }

  /**
   * Initiate a runtime download request.
   * @param runtime The runtime to download.
   */
  protected downloadRuntime(runtime: Runtime): void {
    const current = new Set(this.downloadingIds());
    current.add(runtime.identifier);
    this.downloadingIds.set(current);

    this.api.downloadRuntime({ identifier: runtime.identifier }).subscribe({
      next: () => {
        // Mark runtime as downloading in the local list
        this.updateRuntimeStatus(runtime.identifier, 'downloading');
        const updated = new Set(this.downloadingIds());
        updated.delete(runtime.identifier);
        this.downloadingIds.set(updated);
      },
      error: (err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to start the download. Is the backend running?';
        this.errorMessage.set(msg);
        const updated = new Set(this.downloadingIds());
        updated.delete(runtime.identifier);
        this.downloadingIds.set(updated);
      },
    });
  }

  /**
   * Returns true if a download request is in-flight for the given runtime.
   * @param identifier The runtime identifier.
   */
  protected isDownloading(identifier: string): boolean {
    return this.downloadingIds().has(identifier);
  }

  /**
   * Returns a human-readable size string for a runtime.
   * @param sizeBytes Optional byte count.
   */
  protected formatSize(sizeBytes?: number): string {
    if (sizeBytes === undefined || sizeBytes === 0) return '—';
    const gb = sizeBytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = sizeBytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Fetch all runtimes from the API and split them into platform lists. */
  private loadRuntimes(): void {
    this.loading.set(true);
    this.errorMessage.set('');

    this.api.getRuntimes().subscribe({
      next: (response) => {
        if (response.success && response.data) {
          const all = response.data.runtimes;
          this.iosRuntimes.set(all.filter((r) => r.platform === 'ios'));
          this.androidRuntimes.set(all.filter((r) => r.platform === 'android'));
        } else {
          this.errorMessage.set(
            response.error?.message ?? 'Failed to load runtimes.',
          );
        }
        this.loading.set(false);
      },
      error: () => {
        this.errorMessage.set(
          'Unable to reach the backend. Is the API server running?',
        );
        this.loading.set(false);
      },
    });
  }

  /**
   * Optimistically update the status of a runtime in the local signal arrays.
   * @param identifier The runtime identifier to update.
   * @param status The new status to apply.
   */
  private updateRuntimeStatus(
    identifier: string,
    status: Runtime['status'],
  ): void {
    const patch = (list: Runtime[]): Runtime[] =>
      list.map((r) => (r.identifier === identifier ? { ...r, status } : r));
    this.iosRuntimes.update(patch);
    this.androidRuntimes.update(patch);
  }
}
