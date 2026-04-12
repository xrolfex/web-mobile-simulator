import { Component, inject } from '@angular/core';
import { ToastService } from '../../core/services/toast.service';

/**
 * Toast container component.
 *
 * Renders all active toast notifications in a fixed overlay positioned at the
 * top-right of the viewport. Toasts slide in from the right and can be
 * dismissed by clicking the ✕ button or will auto-dismiss after their
 * configured duration.
 *
 * Add `<app-toast-container />` once in `app.html` (outside the app-shell div)
 * so it is always present at the top level of the DOM.
 */
@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [],
  templateUrl: './toast-container.component.html',
  styleUrl: './toast-container.component.scss',
})
export class ToastContainerComponent {
  /** The global toast service. */
  protected readonly toastService = inject(ToastService);

  /** Exposes the reactive toasts signal to the template. */
  protected readonly toasts = this.toastService.toasts;

  /**
   * Dismiss a toast by its ID.
   * Delegates to {@link ToastService.dismiss}.
   * @param id The `Toast.id` of the toast to remove.
   */
  protected dismiss(id: string): void {
    this.toastService.dismiss(id);
  }
}
