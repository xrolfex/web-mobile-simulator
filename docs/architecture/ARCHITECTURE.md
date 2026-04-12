# web-mobile-simulator — Architecture Documentation

> **Status**: Greenfield / Pre-implementation  
> **Date**: 2026-04-12  
> **Stack**: Angular 21 · Fastify · noVNC · websockify · scrcpy · SQLite (Drizzle ORM) · Docker · nginx · pnpm workspaces

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Table](#2-component-table)
3. [Data Flow: Start Simulator Session](#3-data-flow-start-simulator-session)
4. [Data Flow: OS Version Management](#4-data-flow-os-version-management)
5. [Container Architecture](#5-container-architecture)
6. [Key Architectural Decisions](#6-key-architectural-decisions)

---

## 1. System Overview

The platform streams live iOS Simulator and Android Emulator displays to any web browser. It is designed for self-hosted deployment on physical Mac hardware or AWS EC2 Mac instances. Simulators and emulators run directly on the host macOS OS (they require native hardware); all supporting services are containerised.

```mermaid
flowchart TD
    subgraph Browser["🌐 Browser Client"]
        direction TB
        Angular["Angular 21 SPA\n(Standalone Components · Signals\nOnPush · @if/@for/@switch)"]
        noVNC["noVNC Viewer\n(iOS display)"]
        scrcpyWS["WebRTC / scrcpy-web\n(Android display)"]
        DevicePicker["Device Picker UI\n(OS · Version · Model)"]
        RuntimeMgr_UI["Runtime Manager UI\n(download progress)"]
        Angular --> noVNC
        Angular --> scrcpyWS
        Angular --> DevicePicker
        Angular --> RuntimeMgr_UI
    end

    subgraph Nginx["🔀 Reverse Proxy — nginx"]
        direction TB
        StaticServe["Serve Angular\nstatic build"]
        APIProxy["/api/* → Fastify :3000"]
        WSProxy["WebSocket proxy\n(noVNC / scrcpy ports)"]
    end

    subgraph Fastify["⚙️ Backend API — Fastify / Node.js / TypeScript"]
        direction TB
        SessionAPI["Session API\nPOST /api/sessions\nDELETE /api/sessions/:id"]
        DeviceAPI["Device API\nGET /api/devices"]
        RuntimeAPI["Runtime API\nGET /api/runtimes\nPOST /api/runtimes/download"]
        ProgressWS["Progress WebSocket\n/ws/runtimes/progress"]
        DeviceMgr["Device Manager Service\n(xcrun simctl · adb · avdmanager)"]
        RuntimeMgr["Runtime Manager Service\n(simctl · sdkmanager)"]
        WsockifyMgr["websockify Process Manager\n(dynamic port allocation)"]
        DB[("SQLite\nDrizzle ORM\nsessions · devices")]
        SessionAPI --> DeviceMgr
        SessionAPI --> WsockifyMgr
        SessionAPI --> DB
        DeviceAPI --> DeviceMgr
        DeviceAPI --> DB
        RuntimeAPI --> RuntimeMgr
        RuntimeAPI --> ProgressWS
    end

    subgraph Host["🖥️ Host macOS — Simulator / Emulator Layer"]
        direction TB
        iOSSim["iOS Simulator\n(Xcode / xcrun simctl)\nexposes :590x VNC"]
        AndroidEmu["Android Emulator\n(Android SDK / emulator CLI)\ndisplay via scrcpy"]
        Websockify["websockify\n(VNC TCP → WebSocket\ndynamic ports)"]
        ScrcpyProc["scrcpy server\n(ADB forwarded stream)"]
        Xcode["Xcode + iOS Runtimes"]
        AndroidSDK["Android SDK\n(avdmanager · sdkmanager · adb)"]
        iOSSim --> Websockify
        AndroidEmu --> ScrcpyProc
    end

    Browser -- "HTTPS + WSS" --> Nginx
    Nginx -- "HTTP :3000" --> Fastify
    Nginx -- "WS tunnel" --> Websockify
    Nginx -- "WS / WebRTC tunnel" --> ScrcpyProc
    Fastify -- "spawn / CLI" --> Host
    Fastify -- "port discovery" --> Websockify
```

### Component Boundaries at a Glance

| Layer | Runs In | Communicates Via |
|---|---|---|
| Angular 21 SPA | Browser | HTTPS REST + WSS |
| nginx | Docker container | TCP/Unix socket to Fastify; WS tunnel to host |
| Fastify API | Docker container | Host networking / bind-mount socket to macOS host |
| iOS Simulator | Host macOS | VNC on loopback `:590x` |
| websockify | Host macOS | Bridges VNC TCP → WS |
| Android Emulator | Host macOS | scrcpy ADB stream |
| SQLite | Docker container (volume) | Drizzle ORM from Fastify |

---

## 2. Component Table

| Component | Technology | Role | Port(s) |
|---|---|---|---|
| **Angular SPA** | Angular 21.2.x · TypeScript · standalone components · signals · OnPush | Interactive device picker, noVNC viewer, runtime management UI, WebSocket progress display | N/A (browser-side) |
| **nginx** | nginx (Alpine) | Reverse proxy; serves Angular static build; gzip compression; routes `/api/*` to Fastify; proxies WebSocket connections for VNC and scrcpy streams; SPA fallback | `80`, `8080` |
| **Fastify API** | Fastify · Node.js · TypeScript | REST API for session lifecycle, device inventory, runtime management; manages simulator/emulator processes; allocates websockify ports | `3000` (internal) |
| **Device Manager** | `xcrun simctl` · `adb` · `avdmanager` (Node.js child_process) | Creates, boots, and terminates iOS Simulators and Android Emulators; queries installed devices and runtimes | — (CLI) |
| **Runtime Manager** | `xcrun simctl runtime` · `sdkmanager` (Node.js child_process) | Downloads and registers iOS runtimes and Android system images; streams download progress | — (CLI) |
| **websockify** | websockify (Python/Node) | Bridges VNC TCP connections on loopback to WebSocket endpoints accessible by nginx proxy | Dynamic `:6080`–`:6180` range |
| **scrcpy / scrcpy-web** | scrcpy · WebRTC or WS | Captures Android Emulator display and input; streams to browser via WebRTC or WebSocket | Dynamic (negotiated) |
| **iOS Simulator** | Xcode · `xcrun simctl` | Runs iOS device simulation natively on macOS; exposes display over VNC | `:590x` (loopback) |
| **Android Emulator** | Android SDK `emulator` CLI · QEMU | Runs Android device emulation natively on macOS (requires KVM/HVF acceleration) | `5554`+ (ADB) |
| **SQLite Database** | SQLite · Drizzle ORM | Persists session state, device inventory, runtime catalogue, audit log | — (file, Docker volume) |
| **pnpm Workspaces** | pnpm | Monorepo tooling; manages `apps/frontend`, `apps/api`, `packages/shared` workspaces | — (build-time) |

---

## 3. Data Flow: Start Simulator Session

This sequence covers the complete lifecycle from a user picking a device to interactive streaming beginning, and then the teardown path when the session ends.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant FE as Angular 21 SPA
    participant Nginx as nginx (Reverse Proxy)
    participant API as Fastify API
    participant DevMgr as Device Manager
    participant SimProc as iOS Simulator / Android Emulator (Host)
    participant WSProc as websockify / scrcpy (Host)
    participant DB as SQLite (Drizzle)

    User->>FE: Selects device type, OS version, device model
    FE->>Nginx: POST /api/sessions\n{ platform, osVersion, deviceModel }
    Nginx->>API: POST /api/sessions (proxied)

    API->>DB: Query available devices & runtimes
    DB-->>API: Device list + runtime availability

    alt Platform = iOS
        API->>DevMgr: createSimulator(deviceModel, osVersion)
        DevMgr->>SimProc: xcrun simctl create ...
        SimProc-->>DevMgr: simulatorUDID
        DevMgr->>SimProc: xcrun simctl boot {UDID}
        SimProc-->>DevMgr: boot complete
        DevMgr->>SimProc: xcrun simctl io {UDID} recordVideo --codec=mjpeg\n(or discover VNC port via simctl status)
        SimProc-->>DevMgr: VNC port :590x
        DevMgr->>WSProc: spawn websockify :{dynamicPort} localhost:{vncPort}
        WSProc-->>DevMgr: websockify ready
        DevMgr-->>API: { udid, platform: ios, wsPort: dynamicPort }
    else Platform = Android
        API->>DevMgr: createEmulator(deviceModel, osVersion)
        DevMgr->>SimProc: avdmanager create avd ...
        SimProc-->>DevMgr: AVD name
        DevMgr->>SimProc: emulator -avd {name} -no-window ...
        SimProc-->>DevMgr: emulator booted (adb wait-for-device)
        DevMgr->>WSProc: spawn scrcpy --serial={adbSerial} (WebSocket/WebRTC output)
        WSProc-->>DevMgr: scrcpy stream ready, WS port
        DevMgr-->>API: { avdName, platform: android, wsPort }
    end

    API->>DB: INSERT session { id, platform, udid/avd, wsPort, status: active }
    DB-->>API: sessionId

    API-->>Nginx: 201 { sessionId, wsUrl: wss://host/stream/{sessionId} }
    Nginx-->>FE: 201 session created
    FE->>FE: Initialise noVNC (iOS) or scrcpy-web (Android)\nwith wsUrl

    FE->>Nginx: WSS /stream/{sessionId} (upgrade)
    Nginx->>WSProc: WS proxy → dynamic port
    WSProc-->>Nginx: stream frames
    Nginx-->>FE: stream frames

    Note over FE,WSProc: 🟢 Interactive streaming active

    User->>FE: Closes session / navigates away
    FE->>Nginx: DELETE /api/sessions/{sessionId}
    Nginx->>API: DELETE /api/sessions/{sessionId}
    API->>DevMgr: terminateSession(sessionId)
    DevMgr->>WSProc: kill websockify / scrcpy process
    DevMgr->>SimProc: xcrun simctl shutdown {UDID} (iOS)\nor adb emu kill (Android)
    DevMgr->>SimProc: xcrun simctl delete {UDID} (optional cleanup)
    API->>DB: UPDATE session { status: terminated, endedAt }
    API-->>Nginx: 204 No Content
    Nginx-->>FE: 204
    FE->>FE: Reset viewer, show device picker
```

---

## 4. Data Flow: OS Version Management

Users can browse installed and available runtimes, then trigger downloads. Long-running downloads stream progress back to the browser via WebSocket.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant FE as Angular 21 SPA
    participant Nginx as nginx (Reverse Proxy)
    participant API as Fastify API
    participant RuntimeMgr as Runtime Manager Service
    participant CLI as xcrun simctl / sdkmanager (Host)
    participant DB as SQLite (Drizzle)

    User->>FE: Opens Runtime Manager view
    FE->>Nginx: GET /api/runtimes
    Nginx->>API: GET /api/runtimes
    API->>RuntimeMgr: listRuntimes()

    par iOS runtimes
        RuntimeMgr->>CLI: xcrun simctl runtime list --json
        CLI-->>RuntimeMgr: installed iOS runtime list
    and Android system images
        RuntimeMgr->>CLI: sdkmanager --list --channel=0
        CLI-->>RuntimeMgr: available + installed Android images
    end

    RuntimeMgr-->>API: { ios: [...], android: [...] }
    API->>DB: Upsert runtime catalogue
    API-->>Nginx: 200 { runtimes: { ios, android } }
    Nginx-->>FE: runtime list
    FE->>FE: Render runtime grid\n(installed · available · size · version)

    User->>FE: Clicks "Download" on a runtime
    FE->>Nginx: POST /api/runtimes/download\n{ platform, identifier }
    Nginx->>API: POST /api/runtimes/download

    API->>DB: INSERT runtimeDownload { id, platform, identifier, status: queued }
    API-->>Nginx: 202 Accepted { downloadId, progressWsUrl }
    Nginx-->>FE: 202 { downloadId, progressWsUrl }

    FE->>Nginx: WSS /ws/runtimes/progress/{downloadId}
    Nginx->>API: WS /ws/runtimes/progress/{downloadId}
    Note over FE,API: 🔌 Progress WebSocket established

    API->>RuntimeMgr: startDownload(downloadId, platform, identifier)

    alt Platform = iOS
        RuntimeMgr->>CLI: xcrun simctl runtime add {identifier}
        loop Download in progress
            CLI-->>RuntimeMgr: progress stdout (percentage / bytes)
            RuntimeMgr-->>API: progress event { pct, bytesReceived, total }
            API-->>FE: WS message { type: progress, pct, bytesReceived }
            FE->>FE: Update progress bar (signal-driven)
        end
        CLI-->>RuntimeMgr: exit 0
    else Platform = Android
        RuntimeMgr->>CLI: sdkmanager "{packagePath}"
        loop Download in progress
            CLI-->>RuntimeMgr: progress stdout
            RuntimeMgr-->>API: progress event
            API-->>FE: WS message { type: progress, pct }
            FE->>FE: Update progress bar
        end
        CLI-->>RuntimeMgr: exit 0
    end

    RuntimeMgr-->>API: download complete
    API->>DB: UPDATE runtimeDownload { status: installed }
    API-->>FE: WS message { type: complete, identifier }
    FE->>FE: Mark runtime as "Installed"\nEnable "Create Session" for new OS version
    FE->>Nginx: WS close
```

---

## 5. Container Architecture

Simulators and emulators are **not containerisable** — they require direct access to macOS's Hypervisor framework and Xcode. Only the stateless infrastructure services run inside Docker.

```mermaid
flowchart TB
    subgraph DockerHost["🐳 Docker Compose on macOS Host"]
        direction TB

        subgraph NginxContainer["Container: nginx"]
            NginxProc["nginx\n• Serves /dist/angular (static)\n• gzip compression\n• /api/* → fastify:3000\n• /stream/* → host websockify ports\n• /ws/* → host scrcpy ports\n• SPA fallback"]
            AngularBuild["Angular 21 static build\n(COPY'd during docker build)"]
        end

        subgraph FastifyContainer["Container: api"]
            FastifyProc["Fastify / Node.js\n:3000 (internal)\nSession · Device · Runtime APIs"]
            DrizzleORM["Drizzle ORM"]
        end

        subgraph DBVolume["Volume: db-data"]
            SQLiteFile[("sessions.db\n(SQLite file)")]
        end

        FastifyProc --> DrizzleORM
        DrizzleORM --> SQLiteFile
    end

    subgraph MacOSHost["🖥️ macOS Host (bare metal / EC2 Mac)"]
        direction TB

        subgraph XcodeLayer["Xcode + iOS Toolchain"]
            XcrunSimctl["xcrun simctl"]
            iOSRuntimes["iOS Runtimes\n(downloaded via simctl)"]
            iOSSimProcs["iOS Simulator\nprocesses\n(one per session)"]
        end

        subgraph AndroidLayer["Android SDK"]
            AdbProc["adb"]
            AvdManager["avdmanager"]
            EmulatorProc["emulator CLI\n(QEMU / HVF)\nprocesses\n(one per session)"]
            SystemImages["Android system images\n(downloaded via sdkmanager)"]
        end

        subgraph StreamingLayer["Streaming Bridges"]
            WebsockifyProcs["websockify instances\n(one per iOS session)\nVNC TCP → WS\nports :6080–:6180"]
            ScrcpyProcs["scrcpy instances\n(one per Android session)\nADB stream → WS/WebRTC"]
        end

        iOSSimProcs -- "VNC :590x\n(loopback)" --> WebsockifyProcs
        EmulatorProc -- "ADB :5554+\n(loopback)" --> ScrcpyProcs
    end

    subgraph BrowserClient["🌐 Browser"]
        AngularApp["Angular 21 SPA"]
        noVNCViewer["noVNC viewer\n(iOS)"]
        ScrcpyWebViewer["scrcpy-web / WebRTC\n(Android)"]
        AngularApp --> noVNCViewer
        AngularApp --> ScrcpyWebViewer
    end

    BrowserClient -- "HTTPS :443\nWSS :443" --> NginxContainer
    NginxContainer -- "HTTP :3000\n(host-network or bridge)" --> FastifyContainer
    FastifyContainer -- "child_process\nspawn CLI tools" --> MacOSHost
    NginxContainer -- "WS proxy\n(host port range)" --> StreamingLayer

    note1["⚠️ Docker uses host networking mode\nor explicit port mapping so nginx\ncan proxy to dynamically allocated\nhost-side websockify/scrcpy ports"]
    style note1 fill:#fffbe6,stroke:#f0c040,color:#333
```

### Docker Compose Service Summary

| Service | Image Base | Mounts | Network Mode | Notes |
|---|---|---|---|---|
| `nginx` | `nginx:alpine` | Angular `/dist` (build artifact); `nginx.conf` | Bridge + host port range | Angular static files are `COPY`'d into the image at build time |
| `api` | `node:22-alpine` | `db-data` volume; optional host socket | Bridge (internal) | Communicates with host macOS via TCP (host networking) to reach simulators |
| *(Angular)* | — | — | — | No separate container; built as static files during `nginx` image build |

---

## 6. Key Architectural Decisions

### ADR-001: Simulators / Emulators on Host (Not in Docker)

**Status**: Accepted  
**Context**: iOS Simulators require Xcode, the macOS Hypervisor framework, and GPU access. Android Emulators require macOS HVF acceleration. Neither can run inside a Linux container.  
**Decision**: All simulator/emulator processes run directly on the host macOS. Docker hosts only the stateless API and proxy layers.  
**Consequences**: Deployment is Mac-only (physical or EC2 Mac). Session isolation is process-level, not container-level.

---

### ADR-002: VNC + websockify for iOS Display Streaming

**Status**: Accepted  
**Context**: The iOS Simulator exposes its display via VNC on loopback. Browsers cannot connect to raw TCP VNC.  
**Decision**: Use websockify to bridge VNC TCP → WebSocket, consumed by noVNC in the Angular SPA.  
**Alternatives Considered**: Direct screen capture via `xcrun simctl io` → MJPEG stream (higher latency, lower interactivity). WebRTC (more complex, no native simulator support).  
**Consequences**: Each active iOS session spawns one websockify process. Port range must be managed and proxied through nginx.

---

### ADR-003: scrcpy / WebRTC for Android Display Streaming

**Status**: Accepted  
**Context**: Android Emulator does not expose VNC natively. scrcpy provides low-latency screen capture and input injection via ADB.  
**Decision**: Use scrcpy (with its web variant or WebRTC output) for Android sessions.  
**Alternatives Considered**: VNC via x11vnc (requires virtual X server, higher overhead). Android Emulator's built-in gRPC API (limited browser support).  
**Consequences**: scrcpy must be installed on the macOS host. WebRTC adds STUN/TURN complexity for non-local deployments.

---

### ADR-004: Angular 21 Standalone Components with Signals

**Status**: Accepted  
**Context**: Angular 21 is the current stable release. The app needs reactive UI for streaming state, download progress, and device lifecycle.  
**Decision**: Use standalone components (no NgModules), Angular Signals for reactive state, `@if`/`@for`/`@switch` control flow, and OnPush change detection throughout.  
**Consequences**: Modern Angular patterns only; no legacy NgModule patterns. Smaller bundle, faster change detection, better alignment with Angular's future direction.

---

### ADR-005: nginx as Reverse Proxy

**Status**: Accepted  
**Context**: The platform needs static file serving, API proxying, WebSocket proxying, and gzip compression in a single layer.  
**Decision**: Use nginx for its widespread enterprise adoption, high-performance static file serving, comprehensive WebSocket proxy support, and gzip compression.  
**Alternatives Considered**: Auto-HTTPS reverse proxies (simpler DSL, but less battle-tested for high-concurrency static serving). Traefik (more suited to dynamic container routing than static site serving).  
**Consequences**: `nginx.conf` and `nginx.dev.conf` must be maintained separately for production and development environments. Dynamic upstream port ranges for websockify must be configured via nginx upstream blocks or `proxy_pass` directives.

---

### ADR-006: SQLite via Drizzle ORM

**Status**: Accepted  
**Context**: Session and device state must be persisted. The deployment target is a single Mac node with low concurrent-write requirements.  
**Decision**: SQLite with Drizzle ORM for type-safe schema and migrations. Stored on a named Docker volume.  
**Alternatives Considered**: PostgreSQL (overkill for single-node; adds a container dependency). In-memory store (lost on restart).  
**Consequences**: Not suitable for multi-node horizontal scaling without replacement. Drizzle migrations must run at API container startup.

---

### ADR-007: pnpm Workspaces Monorepo

**Status**: Accepted  
**Context**: The project has at least three logical packages: `apps/frontend` (Angular), `apps/api` (Fastify), and `packages/shared` (TypeScript types/schemas shared between front and back).  
**Decision**: Use pnpm workspaces for monorepo management. Shared types (API response shapes, device models) live in `packages/shared` and are referenced by both apps.  
**Consequences**: Single lock file, fast installs via pnpm's content-addressable store. Docker builds must use `pnpm` and handle workspace hoisting correctly.

---

*Last updated: 2026-04-12 | Architecture Agent*
