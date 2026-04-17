import { Component, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ToastContainerComponent } from './shared/toast/toast-container.component';

/**
 * Root application shell component.
 *
 * Renders the persistent header/nav and hosts the router outlet
 * where feature pages are lazy-loaded. Also mounts the global
 * {@link ToastContainerComponent} overlay so toast notifications are
 * available application-wide.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainerComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  /** Whether the mobile sidebar drawer is currently open. */
  readonly sidebarOpen = signal(false);

  /** Toggles the mobile sidebar open/closed. */
  toggleSidebar(): void {
    this.sidebarOpen.update(open => !open);
  }

  /** Closes the mobile sidebar (used by backdrop click and nav link click). */
  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }
}
