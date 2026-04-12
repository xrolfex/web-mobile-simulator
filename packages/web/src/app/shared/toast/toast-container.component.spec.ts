/**
 * Unit tests for ToastContainerComponent.
 *
 * Angular JIT cannot fetch templateUrl/styleUrl via HTTP in a jsdom
 * environment.  We resolve those resources from the filesystem before any
 * describe() block so that compileComponents() finds them cached.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';

import { ToastContainerComponent } from './toast-container.component';
import { ToastService } from '../../core/services/toast.service';

// ── Resource resolver ─────────────────────────────────────────────────────────

// This spec file lives next to the component, so __dirname points to the
// toast directory.  Angular passes URLs like './toast-container.component.html'
// relative to the component source file.
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)));

function fsResolver(url: string): Promise<string> {
  const normalized = url.replace(/^\.\//, '');
  const candidates = [
    resolve(srcDir, normalized),
    resolve(srcDir, url),
  ];

  for (const candidate of candidates) {
    try {
      return Promise.resolve(readFileSync(candidate, 'utf8'));
    } catch {
      // try next candidate
    }
  }
  // Fall back to empty string so Angular can still compile the component.
  return Promise.resolve('');
}

// Resolve before any describe / beforeEach.
await resolveComponentResources(fsResolver);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ToastContainerComponent', () => {
  let service: ToastService;

  beforeEach(async () => {
    vi.stubGlobal('crypto', { randomUUID: (() => { let n = 0; return () => `uid-${++n}`; })() });
    vi.useFakeTimers();

    await TestBed.configureTestingModule({
      imports: [ToastContainerComponent],
    }).compileComponents();

    service = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── Baseline ─────────────────────────────────────────────────────────────────

  it('should create the component', () => {
    // Arrange + Act
    const fixture = TestBed.createComponent(ToastContainerComponent);

    // Assert
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render no toast elements when the service has no toasts', () => {
    // Arrange + Act
    const fixture = TestBed.createComponent(ToastContainerComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const toastEls = host.querySelectorAll('.toast');
    expect(toastEls).toHaveLength(0);
  });

  // ── Rendering ────────────────────────────────────────────────────────────────

  it('should render one toast element when the service has one toast', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('Hello world');

    // Act
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    expect(host.querySelectorAll('.toast')).toHaveLength(1);
  });

  it('should display the toast message text', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.info('Important notification');

    // Act
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const message = host.querySelector('.toast__message');
    expect(message?.textContent?.trim()).toBe('Important notification');
  });

  it('should render a dismiss button for each toast', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('First');
    service.error('Second');

    // Act
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const dismissButtons = host.querySelectorAll('button.toast__dismiss');
    expect(dismissButtons).toHaveLength(2);
  });

  // ── CSS class per toast type ──────────────────────────────────────────────────

  it('applies toast--success class for a success toast', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('All good');

    // Act
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    expect(host.querySelector('.toast--success')).toBeTruthy();
  });

  it('applies toast--error class for an error toast', () => {
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.error('Something broke');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.toast--error')).toBeTruthy();
  });

  it('applies toast--info class for an info toast', () => {
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.info('Heads up');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.toast--info')).toBeTruthy();
  });

  it('applies toast--warning class for a warning toast', () => {
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.warning('Careful!');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.toast--warning')).toBeTruthy();
  });

  it('only the matching type class is applied to each toast', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('Good');

    // Act
    fixture.detectChanges();
    const toastEl = fixture.nativeElement.querySelector('.toast') as HTMLElement;

    // Assert — success class is present, others are absent
    expect(toastEl.classList.contains('toast--success')).toBe(true);
    expect(toastEl.classList.contains('toast--error')).toBe(false);
    expect(toastEl.classList.contains('toast--info')).toBe(false);
    expect(toastEl.classList.contains('toast--warning')).toBe(false);
  });

  // ── Dismiss interaction ───────────────────────────────────────────────────────

  it('clicking the dismiss button removes the toast from the DOM', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('Click me away');
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const btn = host.querySelector<HTMLButtonElement>('button.toast__dismiss')!;
    expect(btn).toBeTruthy();

    // Act
    btn.click();
    fixture.detectChanges();

    // Assert
    expect(host.querySelectorAll('.toast')).toHaveLength(0);
  });

  it('clicking dismiss on one toast leaves other toasts intact', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('Keep me');
    service.error('Remove me');
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const buttons = host.querySelectorAll<HTMLButtonElement>('button.toast__dismiss');
    // Second button corresponds to the second (error) toast
    expect(buttons).toHaveLength(2);

    // Act
    buttons[1].click();
    fixture.detectChanges();

    // Assert
    const remaining = host.querySelectorAll('.toast');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].classList.contains('toast--success')).toBe(true);
  });

  // ── Accessibility ────────────────────────────────────────────────────────────

  it('should have aria-live="polite" on the container element', () => {
    // Arrange + Act
    const fixture = TestBed.createComponent(ToastContainerComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const container = host.querySelector('.toast-container');
    expect(container?.getAttribute('aria-live')).toBe('polite');
  });

  it('should have role="alert" on each toast element', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.info('Alert role test');
    service.warning('Another alert');

    // Act
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const toastEls = host.querySelectorAll('[role="alert"]');
    expect(toastEls).toHaveLength(2);
  });

  it('dismiss button has an accessible aria-label', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('Accessible dismiss');

    // Act
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const btn = host.querySelector<HTMLButtonElement>('button.toast__dismiss');
    expect(btn?.getAttribute('aria-label')).toBe('Dismiss notification');
  });

  it('toast icon span has aria-hidden="true" to hide decorative emoji from screen readers', () => {
    // Arrange
    const fixture = TestBed.createComponent(ToastContainerComponent);
    service.success('Icon hidden');

    // Act
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const iconSpan = host.querySelector('.toast__icon');
    expect(iconSpan?.getAttribute('aria-hidden')).toBe('true');
  });

  it('container has an aria-label describing its purpose', () => {
    // Arrange + Act
    const fixture = TestBed.createComponent(ToastContainerComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Assert
    const container = host.querySelector('.toast-container');
    expect(container?.getAttribute('aria-label')).toBeTruthy();
  });
});
