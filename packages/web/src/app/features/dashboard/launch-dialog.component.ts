import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  signal,
  computed,
  inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { HttpErrorResponse } from '@angular/common/http';

import { ApiService } from '../../core/services/api.service';
import type { DeviceType, Platform, Runtime } from '../../core/types/api.types';

/**
 * LaunchDialogComponent
 *
 * Modal dialog that lets the user pick a device model and OS runtime for a
 * given platform, then creates a session and navigates to `/session/:id`.
 */
@Component({
  selector: 'app-launch-dialog',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './launch-dialog.component.html',
  styleUrl: './launch-dialog.component.scss',
})
export class LaunchDialogComponent implements OnInit {
  /** Target platform for the new session. */
  @Input({ required: true }) platform!: Platform;

  /** Emitted when the user cancels or the dialog should close. */
  @Output() closeDialog = new EventEmitter<void>();

  // ── Reactive state ───────────────────────────────────────────────────────

  /** Available device types fetched from the API. */
  protected readonly deviceTypes = signal<DeviceType[]>([]);

  /** Installed runtimes fetched from the API and filtered to status=installed. */
  protected readonly runtimes = signal<Runtime[]>([]);

  /** Whether device types are currently loading. */
  protected readonly loadingDevices = signal<boolean>(true);

  /** Whether runtimes are currently loading. */
  protected readonly loadingRuntimes = signal<boolean>(true);

  /** API error message, empty when no error. */
  protected readonly errorMessage = signal<string>('');

  /** Currently selected device type ID. */
  protected readonly selectedDeviceTypeId = signal<string>('');

  /** Currently selected runtime ID. */
  protected readonly selectedRuntimeId = signal<string>('');

  /** Whether the launch request is in-flight. */
  protected readonly launching = signal<boolean>(false);

  /** Platform display label for the dialog title. */
  protected readonly platformLabel = computed<string>(() =>
    this.platform === 'ios' ? 'iOS Simulator' : 'Android Emulator',
  );

  /** Platform icon emoji. */
  protected readonly platformIcon = computed<string>(() =>
    this.platform === 'ios' ? '🍎' : '🤖',
  );

  /** True when both dropdowns have a selection and no request is in-flight. */
  protected readonly canLaunch = computed<boolean>(
    () =>
      !!this.selectedDeviceTypeId() &&
      !!this.selectedRuntimeId() &&
      !this.launching(),
  );

  /** True while either devices or runtimes are still loading. */
  protected readonly isLoading = computed<boolean>(
    () => this.loadingDevices() || this.loadingRuntimes(),
  );

  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngOnInit(): void {
    this.fetchDevices();
    this.fetchRuntimes();
  }

  // ── Template event handlers ──────────────────────────────────────────────

  /** Update selected device type from the dropdown change event. */
  protected onDeviceChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedDeviceTypeId.set(select.value);
  }

  /** Update selected runtime from the dropdown change event. */
  protected onRuntimeChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.selectedRuntimeId.set(select.value);
  }

  /** Create a new session and navigate to the session page. */
  protected async launch(): Promise<void> {
    if (!this.canLaunch()) return;

    this.launching.set(true);
    this.errorMessage.set('');

    this.api
      .createSession({
        platform: this.platform,
        deviceTypeId: this.selectedDeviceTypeId(),
        runtimeId: this.selectedRuntimeId(),
      })
      .subscribe({
        next: (response) => {
          if (!response.success || !response.data) {
            const msg =
              response.error?.message ?? 'Failed to create session.';
            this.errorMessage.set(msg);
            this.launching.set(false);
            return;
          }
          void this.router.navigate(['/session', response.data.session.id]);
        },
        error: (err: unknown) => {
          this.errorMessage.set(this.extractErrorMessage(err));
          this.launching.set(false);
        },
      });
  }

  /** Close the dialog without launching. */
  protected cancel(): void {
    this.closeDialog.emit();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Fetch device types for the current platform. */
  private fetchDevices(): void {
    this.loadingDevices.set(true);
    this.api.getDevices(this.platform).subscribe({
      next: (response) => {
        if (response.success && response.data) {
          this.deviceTypes.set(response.data.deviceTypes);
        } else {
          this.errorMessage.set(
            response.error?.message ?? 'Failed to load device types.',
          );
        }
        this.loadingDevices.set(false);
      },
      error: (err: unknown) => {
        this.errorMessage.set(this.extractErrorMessage(err));
        this.loadingDevices.set(false);
      },
    });
  }

  /**
   * Extract a user-friendly error message from an HTTP error.
   * Handles HttpErrorResponse (Angular), Error, and unknown types.
   */
  private extractErrorMessage(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      if (err.status === 0) {
        return 'Unable to reach the backend. Is the API server running?';
      }
      // Check if the response body has our ApiResponse error envelope
      const body = err.error as { error?: { message?: string } } | null;
      if (body?.error?.message) {
        return body.error.message;
      }
      return `Server error (${err.status}): ${err.statusText}`;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return 'An unexpected error occurred.';
  }

  /** Fetch installed runtimes for the current platform. */
  private fetchRuntimes(): void {
    this.loadingRuntimes.set(true);
    this.api.getRuntimes(this.platform).subscribe({
      next: (response) => {
        if (response.success && response.data) {
          const installed = response.data.runtimes.filter(
            (r) => r.status === 'installed',
          );
          this.runtimes.set(installed);
        } else {
          this.errorMessage.set(
            response.error?.message ?? 'Failed to load runtimes.',
          );
        }
        this.loadingRuntimes.set(false);
      },
      error: (err: unknown) => {
        this.errorMessage.set(this.extractErrorMessage(err));
        this.loadingRuntimes.set(false);
      },
    });
  }
}
