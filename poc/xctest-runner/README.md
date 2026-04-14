# WMSInputRunner — XCTest Command Loop POC

A proof-of-concept Xcode project that runs an iOS UI test as a **persistent command
loop** receiving JSON commands from stdin and sending JSON responses to stdout.

This demonstrates injecting touch/keyboard/device events into an iOS Simulator via
Apple's **XCUIAutomation** framework (which uses IndigoHID under the hood), without
requiring Simulator.app to be the frontmost macOS window.

---

## Why XCUIAutomation Instead of CGEvent?

The existing system uses a precompiled Swift binary that posts `CGEvent` mouse/keyboard
events to `.cghidEventTap`.  That requires:

1. Activating `Simulator.app` (stealing focus from the user's window)
2. Accessibility / Input Monitoring permissions at the macOS system level

**XCUIAutomation** (`XCUIDevice`, `XCUICoordinate`, `XCUIElement`) injects events
directly into the iOS Simulator's IndigoHID event pipeline:

- No window focus required — Simulator.app does not need to be frontmost
- No macOS Accessibility permission needed
- Coordinates are device-relative (normalised 0.0–1.0), not screen-pixel-relative
- Tap/swipe/type via the same infrastructure Xcode uses for automated UI tests

---

## Project Structure

```
poc/xctest-runner/
├── WMSInputRunner/
│   ├── WMSInputRunner.xcodeproj/
│   │   ├── project.pbxproj               # Hand-crafted Xcode project
│   │   └── xcshareddata/xcschemes/
│   │       └── WMSInputRunner.xcscheme   # Shared scheme (builds both targets)
│   ├── WMSInputRunner/
│   │   ├── AppDelegate.swift             # Stub iOS app (host for UI tests)
│   │   └── Info.plist
│   └── WMSInputRunnerUITests/
│       ├── WMSInputRunnerUITests.swift   # The persistent command loop
│       └── Info.plist
└── build-and-run.sh                      # Convenience build + run script
```

---

## How to Build

```bash
cd poc/xctest-runner

# Build (first time ~30 s; subsequent runs skip unchanged files)
xcodebuild build-for-testing \
  -project WMSInputRunner/WMSInputRunner.xcodeproj \
  -scheme WMSInputRunner \
  -destination "platform=iOS Simulator,name=iPhone 17" \
  -configuration Debug
```

On success you will see `** TEST BUILD SUCCEEDED **`.

---

## How to Run

### Using the convenience script

```bash
./build-and-run.sh                 # targets "iPhone 17" by default
./build-and-run.sh "iPhone 17 Pro" # target a different simulator
```

### Manual invocation

```bash
xcodebuild test-without-building \
  -project WMSInputRunner/WMSInputRunner.xcodeproj \
  -scheme WMSInputRunner \
  -destination "platform=iOS Simulator,name=iPhone 17" \
  -configuration Debug \
  -only-testing:"WMSInputRunnerUITests/WMSInputRunnerUITests/testCommandLoop"
```

The test runner boots the simulator (if needed), installs the stub app, and enters
the command loop.  It prints `{"ready":true}` when ready to receive commands.

---

## Command Protocol

One JSON object per line on **stdin**.  One JSON object per line on **stdout**.

### Commands

| Command | Fields | Description |
|---------|--------|-------------|
| `ping` | — | Health-check; returns `{"ok":true}` |
| `tap` | `x`, `y` | Tap at normalised coordinates (0.0–1.0) |
| `swipe` | `x1`, `y1`, `x2`, `y2`, `duration?` | Drag gesture; `duration` defaults to `0.3` s |
| `type` | `text` | Type text into focused element |
| `press` | `button` | Press a hardware button (`"home"`) |
| `orientation` | `value` | Set device orientation |

### `press` buttons

| `button` value | Effect |
|----------------|--------|
| `home` | Press Home button |
| `volumeUp` | Returns error (unsupported in Simulator — see Limitations) |
| `volumeDown` | Returns error (unsupported in Simulator — see Limitations) |

### `orientation` values

`portrait` · `landscapeLeft` · `landscapeRight` · `portraitUpsideDown`

### Responses

```json
{"ok":true}
{"error":"description of what went wrong"}
{"ready":true}
```

### Example session

```
→  {"cmd":"ping"}
←  {"ok":true}

→  {"cmd":"tap","x":0.5,"y":0.5}
←  {"ok":true}

→  {"cmd":"swipe","x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2}
←  {"ok":true}

→  {"cmd":"type","text":"hello world"}
←  {"ok":true}

→  {"cmd":"press","button":"home"}
←  {"ok":true}

→  {"cmd":"orientation","value":"landscapeLeft"}
←  {"ok":true}
```

---

## stdin/stdout Piping — Findings & Limitations

### stdout capture by xcodebuild

`xcodebuild test-without-building` wraps the test runner's stdout with its own
build logs.  The JSON lines written by `WMSInputRunnerUITests.swift` appear inline
with `xcodebuild`'s own `t = …` progress lines.

**For production use**, filter stdout lines that match `/^\{.*\}$/` to isolate JSON
responses from `xcodebuild` log lines.

### stdin works with `readLine()`

Swift's `readLine(strippingNewline:)` reads from the process's stdin.  When launched
via `xcodebuild test`, stdin **is** connected to the terminal/pipe.  Commands typed
or piped in are received correctly.

### Test timeout

XCTest has a default execution timeout (currently 10 minutes for UI tests in Xcode).
For long-running sessions, either:

1. Increase `executionTimeAllowance` in the test plan, or
2. Ping the runner periodically to prove liveness, or
3. Set `XCTEST_EXECUTION_TIME_ALLOWANCE` environment variable before launching.

### volumeUp / volumeDown

`XCUIDevice.Button.volumeUp` and `.volumeDown` are **marked unavailable** on the
iOS Simulator at the Swift API level.  The runner returns an error response for these
buttons rather than crashing.  If hardware button simulation is required, use
`xcrun simctl` (which has `status_bar` and `io` but no volume API either) or the
existing CGEvent approach via Simulator.app keyboard shortcuts.

### App coordinate space

`XCUICoordinate(withNormalizedOffset:)` resolves coordinates relative to the
**stub app's screen frame**.  If you need to interact with a *different* app
(e.g. Safari or Settings), replace `app = XCUIApplication()` with
`app = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")` before calling
`app.launch()` (or skip `launch()` and use `activate()`).

---

## Next Steps (for production integration)

1. **Pipe isolation** — Wrap `xcodebuild` in Node.js using `spawn`, then filter its
   stdout for lines that are valid JSON objects.  All other lines are xcodebuild logs
   and can be discarded or forwarded to a log file.

2. **Named pipe / Unix socket alternative** — If stdout filtering is too noisy,
   write responses to a named FIFO (`mkfifo`) or a Unix domain socket instead of
   stdout.  The Node.js side reads from the same FIFO/socket path.

3. **Larger command set** — Add `keyboard` (key codes), `screenshot`, `findElement`,
   `getAttribute` using the existing XCUIElement query API.

4. **Test plan timeout** — Create an `.xctestplan` file that sets
   `defaultOptions.testTimeoutsEnabled = false` to remove the 10-minute ceiling.

5. **Device selection by UDID** — Pass `udid` via `-destination "id=<UDID>"` instead
   of by name to handle multiple booted simulators.
