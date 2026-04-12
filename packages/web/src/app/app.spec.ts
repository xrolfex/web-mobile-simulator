/**
 * Tests for the root App shell component.
 *
 * Since Vitest runs in a jsdom environment without an HTTP server, Angular JIT
 * cannot fetch external templateUrl / styleUrl files via HTTP.  We resolve
 * those resources from the filesystem once at the top of this file, before
 * any TestBed configuration, so that compileComponents() finds them already
 * cached.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';

import { App } from './app';

// ── Resource resolver ─────────────────────────────────────────────────────────

const srcAppDir = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * Resolve Angular component resources (templateUrl / styleUrl) from the
 * local filesystem.  Angular passes URLs relative to the component source
 * file; here we resolve them relative to the src/app directory.
 */
function fsResolver(url: string): Promise<string> {
  const normalized = url.replace(/^\.\//, '');
  const candidates = [
    resolve(srcAppDir, normalized),
    resolve(srcAppDir, url),
  ];

  for (const candidate of candidates) {
    try {
      return Promise.resolve(readFileSync(candidate, 'utf8'));
    } catch {
      // try next candidate
    }
  }
  // Fall back to empty content so Angular can still compile the component.
  return Promise.resolve('');
}

// Resolve before any describe / beforeEach so the resources are cached when
// TestBed.configureTestingModule() inspects the component definition.
await resolveComponentResources(fsResolver);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('should create the app component', () => {
    // Arrange + Act
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;

    // Assert
    expect(app).toBeTruthy();
  });

  it('should render the brand title in the header', async () => {
    // Arrange
    const fixture = TestBed.createComponent(App);

    // Act
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    // Assert — the template has "Web Mobile Simulator" in the h1
    const h1 = compiled.querySelector('h1');
    expect(h1).toBeTruthy();
    expect(h1?.textContent).toContain('Web Mobile Simulator');
  });

  it('should render Dashboard navigation link', async () => {
    // Arrange
    const fixture = TestBed.createComponent(App);

    // Act
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const navLinks = Array.from(compiled.querySelectorAll('a'));

    // Assert
    const dashboardLink = navLinks.find((a) =>
      a.textContent?.trim().includes('Dashboard'),
    );
    expect(dashboardLink).toBeTruthy();
  });

  it('should render Runtimes navigation link', async () => {
    // Arrange
    const fixture = TestBed.createComponent(App);

    // Act
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const navLinks = Array.from(compiled.querySelectorAll('a'));

    // Assert
    const runtimesLink = navLinks.find((a) =>
      a.textContent?.trim().includes('Runtimes'),
    );
    expect(runtimesLink).toBeTruthy();
  });

  it('should have accessible main nav landmark', async () => {
    // Arrange
    const fixture = TestBed.createComponent(App);

    // Act
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    // Assert — nav should have an aria-label for screen readers
    const nav = compiled.querySelector('nav');
    expect(nav).toBeTruthy();
    expect(nav?.getAttribute('aria-label')).toBeTruthy();
  });

  it('should have a <main> content area', async () => {
    // Arrange
    const fixture = TestBed.createComponent(App);

    // Act
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    // Assert — main landmark present for screen readers
    const main = compiled.querySelector('main');
    expect(main).toBeTruthy();
  });
});
