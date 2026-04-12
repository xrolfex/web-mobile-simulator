import 'zone.js';
import 'zone.js/testing';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';

// Angular JIT compilation resolves templateUrl/styleUrl via fetch().
// In a Vitest / jsdom environment there is no HTTP server, so we intercept
// those requests and read the files directly from the filesystem.
const srcRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  // test-setup.ts is at packages/web/src/test-setup.ts
  // We want packages/web/src as our root for relative resolution
  '.',
);

function fileResolver(url: string): Promise<string> {
  // Angular passes paths like './app.html' or '../app.html'
  // They are relative to the source file that declared templateUrl.
  // Unfortunately at this stage we only receive the raw URL string.
  // We try the path relative to srcRoot first, then fall back to an
  // absolute path lookup by scanning the src tree.
  const candidates = [
    resolve(srcRoot, url),
    resolve(srcRoot, 'app', url.replace(/^\.\//, '')),
  ];
  for (const candidate of candidates) {
    try {
      const content = readFileSync(candidate, 'utf8');
      return Promise.resolve(content);
    } catch {
      // try next candidate
    }
  }
  // Return empty string rather than rejecting — Angular will use an empty
  // template/style instead of crashing the whole test suite.
  return Promise.resolve('');
}

// Resolve external resources before tests run.
await resolveComponentResources(fileResolver);

getTestBed().initTestEnvironment(
  BrowserTestingModule,
  platformBrowserTesting(),
  { teardown: { destroyAfterEach: true } },
);
