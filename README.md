# Web Mobile Simulator

> Stream iOS Simulators and Android Emulators to your browser — self-hosted, no Xcode required on the client.

![Build](https://img.shields.io/badge/build-passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

Web Mobile Simulator is a self-hosted platform that runs iOS Simulators and Android Emulators natively on a Mac host and streams their displays to any browser over WebSocket. It is designed as an open-source alternative to cloud device-streaming services, deployable on physical Mac hardware or AWS EC2 Mac instances.

---

## Table of Contents

1. [Features](#features)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Project Structure](#project-structure)
5. [Development](#development)
6. [Architecture](#architecture)
7. [API Endpoints](#api-endpoints)
8. [Technology Stack](#technology-stack)
9. [Contributing](#contributing)
10. [License](#license)

---

## Features

### Current (MVP)

- ✅ Monorepo architecture with pnpm workspaces
- ✅ Angular 21 SPA frontend with dark theme (standalone components, Signals, OnPush)
- ✅ Fastify 5 API backend with health check endpoint
- ✅ Docker + Caddy containerisation (reverse proxy, static file serving, WebSocket proxy)
- ✅ Shared TypeScript types and constants across frontend and backend

### Roadmap

- 🔲 iOS Simulator streaming via VNC + websockify + noVNC
- 🔲 Android Emulator streaming via scrcpy
- 🔲 OS runtime management — browse, download, and install iOS/Android runtimes
- 🔲 Session lifecycle management (create, stream, terminate)
- 🔲 Multi-session support with dynamic port allocation (VNC range: 6900–6999)
- 🔲 Touch and keyboard input forwarding
- 🔲 SQLite session persistence via Drizzle ORM

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **macOS** | 13+ | Required to run iOS Simulator and Android Emulator (Hypervisor framework) |
| **Xcode** | 15+ | Provides `xcrun simctl` and iOS Simulator runtimes |
| **Android Studio** or **Android SDK CLI** | Latest | Provides `adb`, `avdmanager`, `sdkmanager`, `emulator` |
| **Node.js** | ≥ 20.0.0 | Specified in `engines` field |
| **pnpm** | ≥ 9.0.0 | Workspace manager; install via `npm i -g pnpm` |
| **Docker Desktop for Mac** | Latest | Required for containerised deployment |

> **Note:** iOS Simulators cannot run in Docker or Linux — they require direct access to macOS and the Xcode toolchain. All simulator/emulator processes run on the host; only the API and proxy layers are containerised.

---

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd web-mobile-simulator

# Copy environment config and adjust paths as needed
cp .env.example .env

# Install all workspace dependencies
pnpm install

# Start the Angular dev server and Fastify API in parallel
pnpm dev
```

| Service | URL |
|---|---|
| Angular SPA | http://localhost:4200 |
| Fastify API | http://localhost:3000 |
| Health check | http://localhost:3000/api/health |

---

## Project Structure

```
web-mobile-simulator/
├── packages/
│   ├── api/                  # Fastify 5 REST + WebSocket API
│   │   └── src/
│   │       ├── server.ts     # Entry point — builds and starts Fastify
│   │       ├── config.ts     # Environment-driven config (port, paths, DB, VNC range)
│   │       └── routes/
│   │           ├── health.ts     # GET /api/health  ✅ implemented
│   │           ├── sessions.ts   # Session CRUD     🔲 stub
│   │           ├── devices.ts    # Device types      🔲 stub
│   │           ├── runtimes.ts   # Runtime mgmt      🔲 stub
│   │           └── index.ts      # Route registration
│   │
│   ├── web/                  # Angular 21 SPA
│   │   └── src/              # Standalone components, Signals, OnPush
│   │
│   └── shared/               # Shared TypeScript types and constants
│       └── src/
│           ├── types.ts      # Platform, Session, Device, Runtime interfaces
│           ├── constants.ts  # API routes, WS routes, port ranges, timeouts
│           └── index.ts      # Barrel export
│
├── docs/
│   └── architecture/
│       └── ARCHITECTURE.md   # Full architecture diagrams and ADRs
│
├── scripts/                  # Host setup and utility scripts (in progress)
├── Caddyfile                 # Caddy reverse proxy config (API + WS proxy + SPA fallback)
├── .env.example              # Environment variable template
├── pnpm-workspace.yaml       # Workspace package globs
├── tsconfig.base.json        # Shared TypeScript base config
└── package.json              # Root scripts: dev, build, lint, test
```

---

## Development

### Run in dev mode

```bash
pnpm dev
```

Runs `pnpm dev` in all packages in parallel (`pnpm --parallel -r run dev`):
- `packages/web` → `ng serve` on **:4200**
- `packages/api` → `tsx watch src/server.ts` on **:3000**

### Build all packages

```bash
pnpm build
```

### Run tests

```bash
pnpm test
```

The Angular package uses **Vitest**; the API package has test scaffolding in place.

### Lint

```bash
pnpm lint
```

### Environment variables

Copy `.env.example` to `.env` and update paths for your machine:

```bash
# Server
API_PORT=3000
API_HOST=0.0.0.0

# iOS Simulator
XCODE_PATH=/Applications/Xcode.app

# Android SDK
ANDROID_SDK_ROOT=/Users/$USER/Library/Android/sdk

# Database
DATABASE_URL=file:./data/simulator.db

# VNC proxy port range (one port per active iOS session)
VNC_PROXY_PORT_RANGE_START=6900
VNC_PROXY_PORT_RANGE_END=6999
```

### Run with Docker

```bash
docker-compose up --build
```

This starts the `caddy` and `api` containers. Caddy serves the Angular static build and proxies all `/api/*` and `/ws/*` traffic to the Fastify container on port 3000.

> **Note:** Simulators and emulators run on the macOS host — not inside Docker. The API container communicates back to host tooling (`xcrun`, `adb`, `avdmanager`) via CLI spawning over host networking.

---

## Architecture

The platform is split into four distinct layers:

1. **Browser** — Angular 21 SPA renders the device picker, runtime manager, and embeds noVNC (iOS) or scrcpy-web (Android) for live streaming.
2. **Reverse Proxy (Caddy)** — Serves the Angular static build, routes `/api/*` to Fastify, and proxies WebSocket streams from host-side websockify/scrcpy processes.
3. **API (Fastify / Node.js)** — Manages session lifecycle, spawns and monitors simulator/emulator processes, allocates VNC proxy ports, and persists state to SQLite via Drizzle ORM.
4. **Host macOS** — Runs iOS Simulators (via `xcrun simctl`) and Android Emulators (via `emulator` CLI), plus websockify (VNC→WS bridge) and scrcpy instances — one per active session.

For full data-flow diagrams, container architecture, and architectural decision records (ADRs), see:

📄 **[docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)**

---

## API Endpoints

### REST

| Method | Path | Status | Description |
|---|---|---|---|
| `GET` | `/api/health` | ✅ Implemented | Server status, uptime, version |
| `POST` | `/api/sessions` | 🔲 Stub | Create a new simulator session |
| `GET` | `/api/sessions` | 🔲 Stub | List all active sessions |
| `GET` | `/api/sessions/:id` | 🔲 Stub | Get session details |
| `DELETE` | `/api/sessions/:id` | 🔲 Stub | Terminate a session |
| `GET` | `/api/devices` | 🔲 Stub | List all device types (iOS + Android) |
| `GET` | `/api/devices/:platform` | 🔲 Stub | List device types for `ios` or `android` |
| `GET` | `/api/runtimes` | 🔲 Stub | List all runtimes (installed + available) |
| `GET` | `/api/runtimes/:platform` | 🔲 Stub | List runtimes for `ios` or `android` |
| `POST` | `/api/runtimes/download` | 🔲 Stub | Initiate a background runtime download |

Stub endpoints return `501 NOT_IMPLEMENTED` with an `ApiResponse<never>` error body.

### WebSocket

| Path | Description |
|---|---|
| `/ws/events` | Server-sent events: session state changes, device state changes, errors |
| `/ws/vnc` | VNC stream proxy for active iOS Simulator sessions (via websockify) |

### Response envelope

All REST responses use a shared `ApiResponse<T>` wrapper from `@web-mobile-simulator/shared`:

```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

---

## Technology Stack

| Technology | Version | Role |
|---|---|---|
| **Angular** | 21.2.x | SPA frontend — standalone components, Signals, OnPush, `@if`/`@for` |
| **Fastify** | 5.x | REST + WebSocket API backend |
| **TypeScript** | 5.7 / 5.9 | Language for both API and frontend |
| **noVNC** | Latest | Browser-side VNC viewer for iOS Simulator streaming |
| **websockify** | Latest | Bridges VNC TCP → WebSocket on the macOS host |
| **scrcpy** | Latest | Android Emulator display capture and input injection |
| **SQLite** | — | Session and device state persistence |
| **Drizzle ORM** | Latest | Type-safe schema, queries, and migrations for SQLite |
| **Docker** | — | Containerises the API and Caddy proxy |
| **Caddy** | v2 | Reverse proxy — TLS termination, static serving, WebSocket proxy |
| **pnpm** | 9+ | Monorepo package manager with workspaces |
| **Vitest** | 4.x | Unit testing for the Angular package |

---

## Contributing

Contributions are welcome. The project is in early/greenfield state — the best place to start is the [Architecture document](docs/architecture/ARCHITECTURE.md) to understand the design before picking up an issue.

1. Fork the repository and create a feature branch.
2. Follow the existing TypeScript conventions and shared types in `packages/shared`.
3. Run `pnpm lint` and `pnpm test` before opening a pull request.
4. Reference the relevant ADR or open a discussion if your change affects an architectural decision.

---

## License

MIT © Web Mobile Simulator Contributors
