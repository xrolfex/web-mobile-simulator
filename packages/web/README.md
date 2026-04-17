# @web-mobile-simulator/web

Angular 21 SPA for the Web Mobile Simulator platform.

## Overview

This SPA provides the browser-based UI for the Web Mobile Simulator: a device picker, live simulator streaming (via noVNC and scrcpy-web), and OS runtime management. It communicates with the backend exclusively through `/api/*` REST endpoints and `/ws/*` WebSocket paths at the same origin — never directly to workers. Built with standalone components, Angular Signals, and OnPush change detection throughout.

## Development

This package is **not** run standalone with `ng serve`. Start the full stack from the repo root:

```bash
# From repo root
./scripts/dev.sh
# Open http://localhost:8080
```

`docker-compose.dev.yml` starts the Angular dev server with HMR enabled. The API must be running on the host for the SPA to function — the root dev script handles this automatically.

## Building

Production build (output goes to `dist/`):

```bash
# From repo root
pnpm --filter @web-mobile-simulator/web build
# or build all packages
pnpm build
```

The `dist/` output is automatically `COPY`'d into the nginx container when you run `docker compose up --build`.

## Testing

Unit tests via Vitest:

```bash
pnpm --filter @web-mobile-simulator/web test
# or from repo root
pnpm test
```

## Linting

```bash
pnpm --filter @web-mobile-simulator/web lint
```

## Key Patterns

- **Standalone components** — no NgModules
- **Angular Signals** for reactive state management
- **`@if` / `@for` / `@switch`** built-in control flow syntax
- **OnPush change detection** throughout
- **Backend communication** via `/api/*` REST and `/ws/*` WebSocket (same origin, proxied by nginx)

---

Part of the `web-mobile-simulator` monorepo. See the [root README](../../README.md) for full setup and deployment instructions.
