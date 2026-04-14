import XCTest

// ---------------------------------------------------------------------------
// WMSInputRunnerUITests
//
// Persistent XCTest command loop that reads JSON commands from stdin and
// dispatches them to XCUIAutomation APIs.
//
// Architecture:
//   Node.js → stdin JSON lines → XCTest runner → XCUIDevice / XCUICoordinate
//
// Command protocol (one JSON object per line):
//   {"cmd":"ping"}
//   {"cmd":"tap","x":0.5,"y":0.5}
//   {"cmd":"swipe","x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2,"duration":0.4}
//   {"cmd":"type","text":"hello world"}
//   {"cmd":"press","button":"home"}
//   {"cmd":"orientation","value":"landscapeLeft"}
//
// Response protocol (one JSON object per line on stdout):
//   {"ok":true}
//   {"error":"description"}
// ---------------------------------------------------------------------------

class WMSInputRunnerUITests: XCTestCase {

    // The app proxy for the stub host app installed alongside the test bundle.
    // This gives us a coordinate space to resolve normalised tap/swipe points.
    var app: XCUIApplication!

    // -------------------------------------------------------------------------
    // MARK: - Setup / Teardown
    // -------------------------------------------------------------------------

    override func setUp() {
        super.setUp()
        // Never stop the loop on a failed assertion inside a handler.
        continueAfterFailure = true

        app = XCUIApplication()
        // Launch the stub host app so we have a coordinate space.
        // If a specific simulator device is booted and Simulator.app is open,
        // this attaches to it.  We don't actually care what the app shows —
        // we only use it for coordinate resolution via XCUICoordinate.
        app.launch()
    }

    override func tearDown() {
        app.terminate()
        super.tearDown()
    }

    // -------------------------------------------------------------------------
    // MARK: - Command Loop
    // -------------------------------------------------------------------------

    /// Main entry point.  Signals readiness then blocks reading stdin lines.
    ///
    /// Send commands via stdin (one JSON object per line).
    /// Read responses from stdout (one JSON object per line).
    ///
    /// The loop exits only when stdin is closed (EOF), which happens when the
    /// Node.js parent process terminates.
    func testCommandLoop() {
        // Signal to the parent process that we are ready to receive commands.
        writeJSON(["ready": true])

        // Read commands line-by-line from stdin until EOF.
        // `readLine(strippingNewline:)` blocks the thread until a line arrives.
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            guard
                let data = trimmed.data(using: .utf8),
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let cmd = json["cmd"] as? String
            else {
                writeJSON(["error": "invalid command: could not parse JSON or missing 'cmd' field"])
                continue
            }

            dispatch(cmd: cmd, json: json)
        }

        // stdin closed — parent has gone away; test ends naturally.
    }

    // -------------------------------------------------------------------------
    // MARK: - Dispatcher
    // -------------------------------------------------------------------------

    /// Route a parsed command to the appropriate handler.
    private func dispatch(cmd: String, json: [String: Any]) {
        switch cmd {
        case "ping":
            writeJSON(["ok": true])
        case "tap":
            handleTap(json)
        case "swipe":
            handleSwipe(json)
        case "type":
            handleType(json)
        case "press":
            handlePress(json)
        case "orientation":
            handleOrientation(json)
        default:
            writeJSON(["error": "unknown command: \(cmd)"])
        }
    }

    // -------------------------------------------------------------------------
    // MARK: - Handlers
    // -------------------------------------------------------------------------

    /// Handle `{"cmd":"tap","x":<normX>,"y":<normY>}`.
    ///
    /// Coordinates are normalised (0.0–1.0) relative to the app's frame.
    /// XCUICoordinate translates them to absolute screen points automatically.
    private func handleTap(_ json: [String: Any]) {
        guard
            let x = json["x"] as? Double,
            let y = json["y"] as? Double
        else {
            writeJSON(["error": "tap requires numeric 'x' and 'y'"])
            return
        }

        // XCUICoordinate with a normalised offset resolves against the element's
        // frame at the time of the call — no manual screen-coordinate math needed.
        let coordinate = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
        coordinate.tap()
        writeJSON(["ok": true])
    }

    /// Handle `{"cmd":"swipe","x1":<f>,"y1":<f>,"x2":<f>,"y2":<f>,"duration":<f>}`.
    ///
    /// All coordinates are normalised (0.0–1.0).  Duration defaults to 0.3 s.
    private func handleSwipe(_ json: [String: Any]) {
        guard
            let x1 = json["x1"] as? Double,
            let y1 = json["y1"] as? Double,
            let x2 = json["x2"] as? Double,
            let y2 = json["y2"] as? Double
        else {
            writeJSON(["error": "swipe requires numeric 'x1', 'y1', 'x2', 'y2'"])
            return
        }
        let duration = json["duration"] as? Double ?? 0.3

        let start = app.coordinate(withNormalizedOffset: CGVector(dx: x1, dy: y1))
        let end   = app.coordinate(withNormalizedOffset: CGVector(dx: x2, dy: y2))
        start.press(forDuration: duration, thenDragTo: end)
        writeJSON(["ok": true])
    }

    /// Handle `{"cmd":"type","text":"<string>"}`.
    ///
    /// Types text into whichever element currently has keyboard focus.
    private func handleType(_ json: [String: Any]) {
        guard let text = json["text"] as? String else {
            writeJSON(["error": "type requires 'text'"])
            return
        }
        app.typeText(text)
        writeJSON(["ok": true])
    }

    /// Handle `{"cmd":"press","button":"home|volumeUp|volumeDown"}`.
    ///
    /// Uses `XCUIDevice.shared.press(_:)` — injects via IndigoHID, no window
    /// focus required.
    private func handlePress(_ json: [String: Any]) {
        guard let button = json["button"] as? String else {
            writeJSON(["error": "press requires 'button'"])
            return
        }

        switch button {
        case "home":
            XCUIDevice.shared.press(.home)
        case "volumeUp":
            // volumeUp/volumeDown are unavailable on the Simulator at the API
            // level — XCUIDevice.Button.volumeUp is marked unavailable in iOS
            // when running under Simulator.  We return a descriptive error so
            // the caller knows the limitation without crashing the runner.
            writeJSON(["error": "volumeUp is not supported in the iOS Simulator"])
            return
        case "volumeDown":
            writeJSON(["error": "volumeDown is not supported in the iOS Simulator"])
            return
        default:
            writeJSON(["error": "unknown button: \(button)"])
            return
        }
        writeJSON(["ok": true])
    }

    /// Handle `{"cmd":"orientation","value":"portrait|landscapeLeft|landscapeRight|portraitUpsideDown"}`.
    ///
    /// Uses `XCUIDevice.shared.orientation` — sets orientation directly
    /// without requiring window focus.
    private func handleOrientation(_ json: [String: Any]) {
        guard let value = json["value"] as? String else {
            writeJSON(["error": "orientation requires 'value'"])
            return
        }

        let orientation: UIDeviceOrientation
        switch value {
        case "portrait":
            orientation = .portrait
        case "landscapeLeft":
            orientation = .landscapeLeft
        case "landscapeRight":
            orientation = .landscapeRight
        case "portraitUpsideDown":
            orientation = .portraitUpsideDown
        default:
            writeJSON(["error": "unknown orientation: \(value)"])
            return
        }

        XCUIDevice.shared.orientation = orientation
        writeJSON(["ok": true])
    }

    // -------------------------------------------------------------------------
    // MARK: - Output helper
    // -------------------------------------------------------------------------

    /// Serialise `object` to compact JSON and write it as a single line on stdout.
    ///
    /// `fflush` is called after every write so Node.js receives the line
    /// immediately rather than waiting for the output buffer to fill.
    private func writeJSON(_ object: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: object),
            let line = String(data: data, encoding: .utf8)
        else {
            // Fallback — write a raw error marker so the reader doesn't hang.
            print("{\"error\":\"internal: could not serialise response\"}")
            fflush(stdout)
            return
        }
        print(line)
        fflush(stdout)
    }
}
