# Web Mobile Simulator

> Stream iOS Simulators and Android Emulators to your browser — self-hosted, no Xcode required on the client.

![Build](https://img.shields.io/badge/build-passing-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

Web Mobile Simulator is a self-hosted platform that runs iOS Simulators and Android Emulators natively on a Mac host and streams their displays to any browser over WebSocket. It is designed as an open-source alternative to cloud device-streaming services, deployable on physical Mac hardware or AWS EC2 Mac instances — and scalable across multiple Mac nodes via its distributed master/worker architecture.

---

## Table of Contents

1. [Features](#features)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Project Structure](#project-structure)
5. [Development](#development)
6. [Deployment Modes](#deployment-modes)
7. [Architecture](#architecture)
8. [API Endpoints](#api-endpoints)
9. [Technology Stack](#technology-stack)
10. [Contributing](#contributing)
11. [License](#license)

---

## Features

- ✅ Monorepo architecture with pnpm workspaces
- ✅ Angular 21 SPA frontend with dark theme (standalone components, Signals, OnPush)
- ✅ Fastify 5 API backend
- ✅ Docker + nginx containerisation (reverse proxy, static file serving, WebSocket proxy)
- ✅ Shared TypeScript types and constants across frontend and backend
- ✅ iOS Simulator streaming via screenshot-based MJPEG and native H.264 encoding
- ✅ Android Emulator streaming via scrcpy (H.264 NALU + WebCodecs decoding in browser)
- ✅ Device control — hardware buttons, rotation, shake, clipboard, URL opening, text input, screenshots
- ✅ App installation — upload and install .ipa/.apk files directly to running sessions
- ✅ App library — persistent per-user app storage with install-to-session support
- ✅ Admin endpoints — session history cleanup, force-purge, capacity monitoring
- ✅ OS runtime management — browse, download, and install iOS/Android runtimes
- ✅ Session lifecycle management with SQLite persistence via Drizzle ORM
- ✅ Multi-session support with dynamic port allocation
- ✅ **Distributed master/worker mode** — scale across multiple Mac nodes with `NODE_MODE=standalone|master|worker`

---

## Prerequisites

| Requirement                               | Version | Notes                                                                     |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------- |
| **macOS**                                 | 13+     | Required to run iOS Simulator and Android Emulator (Hypervisor framework) |
| **Xcode**                                 | 15+     | Provides `xcrun simctl` and iOS Simulator runtimes                        |
| **Android Studio** or **Android SDK CLI** | Latest  | Provides `adb`, `avdmanager`, `sdkmanager`, `emulator`                    |
| **Node.js**                               | 24.x    | Pinned via `.nvmrc` and enforced in `engines`                             |
| **pnpm**                                  | ≥ 9.0.0 | Workspace manager; install via `npm i -g pnpm`                            |
| **Docker Desktop for Mac**                | Latest  | Required for containerised deployment                                     |

> **Note:** iOS Simulators cannot run in Docker or Linux — they require direct access to macOS and the Xcode toolchain. All simulator/emulator processes run on the host.

> **Master nodes** do not require Xcode or Android SDK — they can run anywhere, including Docker. Only **worker nodes** (and **standalone** mode) require macOS, Xcode, and Android SDK.

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

# Start the hybrid dev environment (API on host + Angular/nginx in Docker)
./scripts/dev.sh
```

| Service            | URL                              |
| ------------------ | -------------------------------- |
| App (via nginx)    | http://localhost:8080            |
| Fastify API (host) | http://localhost:3000            |
| Health check       | http://localhost:3000/api/health |

---

## Project Structure

```
web-mobile-simulator/
├── packages/
│   ├── api/                  # Fastify 5 REST + WebSocket API
│   │   └── src/
│   │       ├── server.ts     # Entry point — mode-based startup/shutdown
│   │       ├── config.ts     # Environment-driven config (port, paths, DB, VNC, distributed)
│   │       ├── db/
│   │       │   ├── index.ts                       # DB barrel export
│   │       │   ├── schema.ts                      # Drizzle schema (sessions, session_worker_map, app_library)
│   │       │   ├── migrate.ts                     # DDL runner at startup
│   │       │   ├── session-repository.ts          # Session CRUD
│   │       │   ├── session-worker-map-repository.ts  # Master routing table CRUD
│   │       │   └── app-library-repository.ts      # App library persistence
│   │       ├── services/
│   │       │   ├── index.ts                       # Service barrel export
│   │       │   ├── session-manager.ts             # Session lifecycle orchestration
│   │       │   ├── ios-simulator.ts               # iOS Simulator control (simctl, touch, keys)
│   │       │   ├── android-emulator.ts            # Android Emulator control (adb, emulator CLI)
│   │       │   ├── screen-capture.ts              # MJPEG + H.264 NALU capture and streaming
│   │       │   ├── event-bus.ts                   # In-process event pub/sub
│   │       │   ├── app-install.ts                 # App binary installation to devices
│   │       │   ├── app-library-service.ts         # Persistent app library management
│   │       │   ├── worker-registry.ts             # Master-side worker registry
│   │       │   ├── worker-registration.ts         # Worker-side registration + heartbeat
│   │       │   └── session-router.ts              # Session routing + HTTP/WS proxy
│   │       ├── routes/
│   │       │   ├── index.ts           # Mode-based route registration
│   │       │   ├── health.ts          # GET /api/health
│   │       │   ├── sessions.ts        # Session CRUD (standalone / worker)
│   │       │   ├── devices.ts         # Device inventory
│   │       │   ├── runtimes.ts        # Runtime management
│   │       │   ├── device-control.ts  # Hardware buttons, rotation, clipboard, etc.
│   │       │   ├── apps.ts            # App upload + install to sessions
│   │       │   ├── app-library.ts     # Persistent app library CRUD
│   │       │   ├── admin.ts           # Admin session management
│   │       │   ├── ws-events.ts       # WebSocket event stream
│   │       │   ├── ws-stream.ts       # MJPEG + H.264 display streaming
│   │       │   ├── master-sessions.ts # POST/DELETE sessions (master mode)
│   │       │   ├── master-proxy.ts    # HTTP + WS proxy to workers (master mode)
│   │       │   └── internal.ts        # /internal/workers/* registration + heartbeat
│   │       └── utils/
│   │           └── exec.ts            # Child process execution helper
│   │
│   ├── web/                  # Angular 21 SPA
│   │   └── src/              # Standalone components, Signals, OnPush
│   │
│   └── shared/               # Shared TypeScript types and constants
│       └── src/
│           ├── types.ts      # Platform, Session, Device, Runtime, Worker interfaces
│           ├── constants.ts  # API routes, WS routes, port ranges, timeouts
│           └── index.ts      # Barrel export
│
├── docs/
│   └── architecture/
│       └── ARCHITECTURE.md   # Full architecture diagrams, ADRs
│
├── scripts/
│   ├── dev.sh
│   ├── setup-host.sh
│   ├── start.sh
│   ├── stop.sh
│   ├── health-check.sh
│   ├── install-ios-runtime.sh
│   └── install-android-image.sh
├── Dockerfile.api            # API container image
├── Dockerfile.dev            # Development container image
├── Dockerfile.web            # Angular build + static serving image
├── docker-compose.yml        # Production compose (nginx + master + worker)
├── docker-compose.dev.yml    # Dev compose (Angular + nginx only)
├── nginx.conf
├── nginx.dev.conf
├── eslint.config.mjs
├── .env.example
├── .nvmrc
├── .npmrc
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

---

## Development

### Development (hybrid: API on host + Docker)

The API server runs directly on macOS because it needs access to Xcode CLI tools
(`xcrun simctl`), Android SDK (`avdmanager`, `emulator`, `adb`), and other
macOS-native binaries that cannot run inside Linux containers.

**Quick start** (recommended):

```bash
./scripts/dev.sh
```

This script builds shared types, starts the API on the host, and launches
the Angular dev server + nginx in Docker. Open [http://localhost:8080](http://localhost:8080).

**Manual start** (step by step):

```bash
# 1. Build shared types (needed by both API and web)
pnpm --filter @web-mobile-simulator/shared build

# 2. Start the API on the host (port 3000)
pnpm --filter @web-mobile-simulator/api run dev

# 3. In another terminal, start Docker (Angular + nginx)
docker compose -f docker-compose.dev.yml up --build

# 4. Open http://localhost:8080
```

**Stop everything:**

```bash
./scripts/dev.sh --stop
```

> **Note:** `docker-compose.dev.yml` starts the **web (Angular)** and **nginx** containers only.
> The API runs on the host — it is **not** started by Docker Compose in dev mode.

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

Copy `.env.example` to `.env` and update paths for your machine.

#### Standalone / Worker

```bash
# Server
API_PORT=3000
API_HOST=0.0.0.0

# iOS Simulator (not needed on master)
XCODE_PATH=/Applications/Xcode.app

# Android SDK (not needed on master)
ANDROID_SDK_ROOT=/Users/$USER/Library/Android/sdk

# Database
DATABASE_URL=file:./data/simulator.db

# Session Concurrency
MAX_CONCURRENT_SESSIONS=6
MAX_SESSIONS_PER_PLATFORM=0
SESSION_MEMORY_EVICTION_MS=900000
IOS_WARM_POOL_SIZE=0
```

#### Distributed mode

```bash
# Deployment mode: standalone | master | worker (default: standalone)
NODE_MODE=standalone

# Worker → Master: base URL of the master node (required when NODE_MODE=worker)
MASTER_URL=

# Shared secret for master ↔ worker authentication (set on both master and workers)
WORKER_SECRET=

# Worker → Master: publicly reachable URL of this worker (required when NODE_MODE=worker)
WORKER_PUBLIC_URL=

# Worker capacity limits
WORKER_MAX_IOS_SESSIONS=3
WORKER_MAX_ANDROID_SESSIONS=2

# Worker heartbeat interval (ms)
WORKER_HEARTBEAT_INTERVAL_MS=30000
```

### Production

#### Scenario A — Single-machine (standalone)

`NODE_MODE=standalone` is the default. `docker-compose.yml` starts `nginx`, `master` (acts as both API + proxy), and a demo `worker` container:

```bash
docker compose up --build
```

nginx serves the Angular static build and proxies all `/api/*` and `/ws/*` traffic to the Fastify container on port 3000.

> **Note:** The `docker-compose.yml` services are `nginx`, `master`, and `worker` (not `api`). The `master` service runs with `NODE_MODE=master`. The `worker` service in Docker is a **demo stub only** — it has no iOS/Android toolchain. Real workers must run on macOS hosts.

#### Scenario B — Multi-machine (distributed)

On the **master** machine (can be Linux/Docker):

```bash
NODE_MODE=master WORKER_SECRET=<secret> docker compose up --build
```

On each **macOS worker** machine:

```bash
NODE_MODE=worker \
  MASTER_URL=http://<master-ip>:3000 \
  WORKER_PUBLIC_URL=http://<this-host>:3000 \
  WORKER_SECRET=<secret> \
  pnpm --filter @web-mobile-simulator/api start
```

Workers self-register with the master on startup and send periodic heartbeats. The master uses least-loaded worker selection when routing new session requests.

---

## Deployment Modes

| Mode       | `NODE_MODE`             | Requires macOS / Xcode?                    | Role                                                                          |
| ---------- | ----------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Standalone | `standalone` (default)  | ✅ Yes                                     | Single machine — runs simulators locally, no distribution                     |
| Master     | `master`                | ❌ No (runs anywhere, including Docker)    | Orchestration only — routes requests to workers, no simulators                |
| Worker     | `worker`                | ✅ Yes (macOS + Xcode + Android SDK)       | Simulation node — registers with master, runs simulators                      |

---

## Architecture

The platform is split into four distinct layers:

1. **Browser** — Angular 21 SPA renders the device picker, runtime manager, and uses WebCodecs (H.264) or an MJPEG image stream for live simulator/emulator display with touch and keyboard input forwarding.
2. **Reverse Proxy (nginx)** — Serves the Angular static build, routes `/api/*` to Fastify, and proxies WebSocket streams (`/ws/*`) to the API server.
3. **API (Fastify / Node.js)** — Manages session lifecycle, spawns and monitors simulator/emulator processes, captures screens (MJPEG screenshots or H.264 NALU encoding), and persists state to SQLite via Drizzle ORM. In master mode, routes requests to registered workers via HTTP + WebSocket proxy.
4. **Host macOS** — Runs iOS Simulators (via `xcrun simctl`) and Android Emulators (via `emulator` CLI), plus scrcpy instances for Android streaming — one per active session.

For full data-flow diagrams, container architecture, and architectural decision records (ADRs), see:

📄 **[docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)**

---

## API Endpoints

### REST

| Method   | Path                                    | Status         | Description                                    |
| -------- | --------------------------------------- | -------------- | ---------------------------------------------- |
| `GET`    | `/api/health`                           | ✅ Implemented | Server status, uptime, version                 |
| `POST`   | `/api/sessions`                         | ✅ Implemented | Create a new simulator session                 |
| `GET`    | `/api/sessions`                         | ✅ Implemented | List all active sessions                       |
| `GET`    | `/api/sessions/:id`                     | ✅ Implemented | Get session details                            |
| `DELETE` | `/api/sessions/:id`                     | ✅ Implemented | Terminate a session                            |
| `GET`    | `/api/devices`                          | ✅ Implemented | List all device types (iOS + Android)          |
| `GET`    | `/api/devices/:platform`                | ✅ Implemented | List device types for `ios` or `android`       |
| `GET`    | `/api/runtimes`                         | ✅ Implemented | List all runtimes (installed + available)      |
| `GET`    | `/api/runtimes/:platform`               | ✅ Implemented | List runtimes for `ios` or `android`           |
| `POST`   | `/api/runtimes/download`                | ✅ Implemented | Initiate a background runtime download         |

### Device Control

| Method   | Path                                    | Status         | Description                                    |
| -------- | --------------------------------------- | -------------- | ---------------------------------------------- |
| `POST`   | `/api/sessions/:id/control/button`      | ✅ Implemented | Press a hardware button (home, lock, volume)   |
| `POST`   | `/api/sessions/:id/control/rotate`      | ✅ Implemented | Set device orientation                         |
| `POST`   | `/api/sessions/:id/control/shake`       | ✅ Implemented | Trigger shake gesture (iOS only)               |
| `GET`    | `/api/sessions/:id/control/screenshot`  | ✅ Implemented | Capture and return a PNG screenshot            |
| `POST`   | `/api/sessions/:id/control/clipboard`   | ✅ Implemented | Set clipboard text                             |
| `GET`    | `/api/sessions/:id/control/clipboard`   | ✅ Implemented | Get clipboard text                             |
| `POST`   | `/api/sessions/:id/control/open-url`    | ✅ Implemented | Open a URL or deep-link on the device          |
| `POST`   | `/api/sessions/:id/control/send-text`   | ✅ Implemented | Type text into the focused input field         |

### App Management

| Method   | Path                                    | Status         | Description                                    |
| -------- | --------------------------------------- | -------------- | ---------------------------------------------- |
| `POST`   | `/api/sessions/:id/apps`                | ✅ Implemented | Upload and install an app on a running session |
| `GET`    | `/api/apps`                             | ✅ Implemented | List apps in the user's library                |
| `POST`   | `/api/apps`                             | ✅ Implemented | Upload a new app to the library                |
| `GET`    | `/api/apps/:id`                         | ✅ Implemented | Get a single app library entry                 |
| `DELETE` | `/api/apps/:id`                         | ✅ Implemented | Delete an app from the library                 |
| `POST`   | `/api/apps/:id/install/:sessionId`      | ✅ Implemented | Install a library app into a session           |

### Admin

| Method   | Path                                    | Status         | Description                                    |
| -------- | --------------------------------------- | -------------- | ---------------------------------------------- |
| `GET`    | `/api/admin/sessions`                   | ✅ Implemented | List ALL sessions with capacity info           |
| `DELETE` | `/api/admin/sessions/history`           | ✅ Implemented | Clear all terminated/error sessions            |
| `DELETE` | `/api/admin/sessions/:id`               | ✅ Implemented | Force-purge a single session                   |

### Internal API (master/worker only)

| Method   | Path                                    | Description                              |
| -------- | --------------------------------------- | ---------------------------------------- |
| `POST`   | `/internal/workers/register`            | Worker registers with master             |
| `POST`   | `/internal/workers/:workerId/heartbeat` | Worker sends heartbeat to master         |
| `DELETE` | `/internal/workers/:workerId`           | Worker deregisters from master           |
| `GET`    | `/internal/workers`                     | List all registered workers              |

### WebSocket

| Path                          | Description                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/ws/events`                  | Server-sent events: session state changes, device state changes, errors                              |
| `/ws/stream/:sessionId`       | Display stream — supports MJPEG (default) and H.264 NALU mode (`?format=h264`) with touch/key input |

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

| Technology      | Version         | Role                                                                            |
| --------------- | --------------- | ------------------------------------------------------------------------------- |
| **Angular**     | 21.2.x          | SPA frontend — standalone components, Signals, OnPush, `@if`/`@for`             |
| **Fastify**     | 5.x             | REST + WebSocket API backend                                                    |
| **TypeScript**  | 5.7 / 5.9       | Language for both API and frontend                                              |
| **WebCodecs**   | —               | Browser-side H.264 decoding for low-latency simulator/emulator streaming    |
| **scrcpy**      | Latest          | Android Emulator display capture and input injection                            |
| **SQLite**      | —               | Session and device state persistence                                            |
| **Drizzle ORM** | Latest          | Type-safe schema, queries, and migrations for SQLite                            |
| **Docker**      | —               | Containerises nginx and the Angular build (all services in production)          |
| **nginx**       | latest (Alpine) | Reverse proxy — static serving, gzip compression, WebSocket proxy, SPA fallback |
| **pnpm**        | 9+              | Monorepo package manager with workspaces                                        |
| **Vitest**      | 4.x             | Unit testing for the Angular package                                            |

---

## Contributing

Contributions are welcome. The best place to start is the [Architecture document](docs/architecture/ARCHITECTURE.md) to understand the design before picking up an issue.

1. Fork the repository and create a feature branch.
2. Follow the existing TypeScript conventions and shared types in `packages/shared`.
3. Run `pnpm lint` and `pnpm test` before opening a pull request.
4. Reference the relevant ADR or open a discussion if your change affects an architectural decision.

---

## License

MIT © Web Mobile Simulator Contributors
