/// wms-indigo-poc.swift
///
/// Proof-of-Concept: Inject touch events into an iOS Simulator using
/// SimulatorKit's IndigoHID mechanism, bypassing the macOS window server
/// entirely (no CGEvent, no Simulator.app focus required).
///
/// Build:   see build.sh
/// Usage:
///   wms-indigo-poc --discover
///   wms-indigo-poc <udid> tap <normX> <normY>
///
/// Technique:
///   1. dlopen CoreSimulator + SimulatorKit private frameworks
///   2. Use NSClassFromString / ObjC runtime to find SimServiceContext,
///      SimDeviceSet, and the target SimDevice by UDID
///   3. Create a SimDeviceLegacyHIDClient for the device (Swift class in
///      SimulatorKit — accessed via ObjC runtime bridging)
///   4. Synthesise an IndigoHIDMessageStruct touch (down + up) using
///      IndigoHIDMessageForMouseNSEvent (C function in SimulatorKit)
///   5. Send the message via SimDeviceLegacyHIDClient.send(message:)
///
/// Author: WMS POC — Eric (via Builder agent), 2026

import Foundation
import AppKit
import ObjectiveC

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Framework loading
// ──────────────────────────────────────────────────────────────────────────────

/// Paths to the private frameworks we need.
let kCoreSimulatorPath =
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
let kSimulatorKitPath =
    "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"

/// Load a dynamic library, aborting with a diagnostic if it fails.
func loadFramework(_ path: String) {
    guard dlopen(path, RTLD_NOW | RTLD_GLOBAL) != nil else {
        let reason = String(cString: dlerror())
        fputs("❌ Failed to load \(path)\n   Reason: \(reason)\n", stderr)
        exit(1)
    }
    print("✅ Loaded \(path)")
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - ObjC runtime helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Perform a zero-argument selector on an object, returning the result as AnyObject?.
@discardableResult
func objcCall(_ obj: AnyObject, sel: Selector) -> AnyObject? {
    guard obj.responds(to: sel) else { return nil }
    return obj.perform(sel)?.takeUnretainedValue()
}

/// Perform a one-argument selector on an object.
@discardableResult
func objcCall(_ obj: AnyObject, sel: Selector, with arg: AnyObject?) -> AnyObject? {
    guard obj.responds(to: sel) else { return nil }
    return obj.perform(sel, with: arg)?.takeUnretainedValue()
}

/// Perform a two-argument selector on an object.
@discardableResult
func objcCall(_ obj: AnyObject, sel: Selector, with arg1: AnyObject?, and arg2: AnyObject?) -> AnyObject? {
    guard obj.responds(to: sel) else { return nil }
    return obj.perform(sel, with: arg1, with: arg2)?.takeUnretainedValue()
}

/// Return all method names on an ObjC class.
func methodNames(of cls: AnyClass) -> [String] {
    var count: UInt32 = 0
    guard let methods = class_copyMethodList(cls, &count) else { return [] }
    defer { free(methods) }
    return (0..<Int(count)).map { NSStringFromSelector(method_getName(methods[$0])) }
}

/// Return all class method names on an ObjC class.
func classMethodNames(of cls: AnyClass) -> [String] {
    guard let meta = object_getClass(cls) else { return [] }
    return methodNames(of: meta)
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - IndigoHIDMessageStruct (opaque)
// ──────────────────────────────────────────────────────────────────────────────

/// Opaque representation of IndigoHIDMessageStruct.
/// The actual layout is private, but we only need to hold a pointer
/// returned by IndigoHIDMessageForMouseNSEvent and pass it to send().
/// Size is at least 0x200 bytes based on disassembly of IndigoHIDMessageForMouseNSEvent
/// (calloc(1, 0x200) observed at 0x11284–0x112ec in SimulatorKit arm64e).
struct IndigoHIDMessageStruct {
    var storage: (
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64,
        UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64, UInt64
    ) = (
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
    )
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - IndigoHID C-function signatures (resolved via dlsym)
// ──────────────────────────────────────────────────────────────────────────────

/// IndigoHIDMessageForMouseNSEvent signature (reverse-engineered from the
/// embedded debug string in SimulatorKit binary).
///
/// C signature:
///   IndigoHIDMessage *IndigoHIDMessageForMouseNSEvent(
///       CGPoint *point0,        // x0 — pointer to primary touch coords (0.0–1.0)
///       CGPoint *point1,        // x1 — pointer to secondary touch coords (NULL for single)
///       IndigoHIDTarget target, // x2 — HID target (0x40000000 for digitizer touch, 0x35 for pointer)
///       NSEventType eventType,  // x3 — 1 = ButtonEventTypeDown, 2 = ButtonEventTypeUp
///       NSSize size,            // d0 = width, d1 = height — scale divisors (1.0, 1.0)
///       IndigoHIDEdge edge      // x4 — edge flags (0 = none)
///   )
///
/// arm64 register layout (integer and float register files are independent):
///   x0 = point0  (pointer)
///   x1 = point1  (pointer, nil for single touch)
///   x2 = target  (integer, 0x40000000 for digitizer touch)
///   x3 = eventType (integer, 1=down / 2=up)
///   x4 = edge    (integer, 0 = none)
///   d0 = size.width  (float, 1.0)
///   d1 = size.height (float, 1.0)
///
/// Swift @convention(c) assigns x-registers to pointer/integer params in
/// declaration order, and d-registers to float params in declaration order,
/// independently — so listing all pointer/int params first, then floats,
/// then the trailing int correctly maps every argument to its register.
///
/// Returns: heap-allocated pointer to IndigoHIDMessageStruct (caller should
///          not free when passing freeWhenDone:false to the send call).
typealias IndigoHIDMessageForMouseNSEventFn = @convention(c) (
    UnsafeMutableRawPointer?,   // x0 — point0 (CGPoint*, primary touch coords)
    UnsafeMutableRawPointer?,   // x1 — point1 (CGPoint*, nil for single touch)
    UInt,                        // x2 — target (0x40000000 for digitizer, 0x35 for pointer)
    UInt,                        // x3 — eventType (1=down, 2=up)
    Double,                      // d0 — size.width  (1.0)
    Double,                      // d1 — size.height (1.0)
    UInt                         // x4 — edge (0 = none)
) -> UnsafeMutableRawPointer?

/// IndigoHIDMessageForKeyboardArbitrary — keyboard events via USB HID usage code.
///
/// C signature (reverse-engineered from SimulatorKit disassembly):
///   IndigoHIDMessage *IndigoHIDMessageForKeyboardArbitrary(
///       uint32_t usageCode,   // x0 — USB HID Keyboard/Keypad page usage code
///       uint32_t keyState     // x1 — 1=down, 2=up
///   )
///
/// The function allocates a 0xC0-byte struct, sets message type to 3 (keyboard),
/// populates the usage code and key state. No target parameter needed.
typealias IndigoHIDMessageForKeyboardArbitraryFn = @convention(c) (
    UInt32,   // x0 — usageCode (USB HID usage code, e.g. 0x04='a', 0x28=Enter)
    UInt32    // x1 — keyState (1=down, 2=up)
) -> UnsafeMutableRawPointer?

/// IndigoHIDMessageForButton — hardware button events (home, lock, volume).
///
/// C signature (reverse-engineered from SimulatorKit disassembly):
///   IndigoHIDMessage *IndigoHIDMessageForButton(
///       uint32_t buttonCode,  // x0 — button key code
///       uint32_t keyState,    // x1 — 1=down, 2=up
///       uint32_t target       // x2 — IndigoHIDTarget (0x33 for iPhone)
///   )
///
/// Button codes (from SimulatorKit/Simulator.app disassembly):
///   1    = Home button
///   2000 = Volume Down
///   2001 = Volume Up
///   2002 = Lock/Side button
typealias IndigoHIDMessageForButtonFn = @convention(c) (
    UInt32,   // x0 — buttonCode
    UInt32,   // x1 — keyState (1=down, 2=up)
    UInt32    // x2 — target (0x33 for iPhone/iPad)
) -> UnsafeMutableRawPointer?

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Discover mode
// ──────────────────────────────────────────────────────────────────────────────

/// Print a formatted list of known CoreSimulator / SimulatorKit ObjC classes
/// and their instance + class methods. Uses targeted `NSClassFromString` lookups
/// rather than `objc_copyClassList`, which hangs when iterating ~60 k classes
/// (triggers Swift runtime realization for every class in the loaded images).
func discoverClasses() {
    // Known ObjC/Swift class names in CoreSimulator and SimulatorKit.
    // Add more names here as needed; each is looked up with NSClassFromString.
    let knownNames: [String] = [
        // CoreSimulator
        "SimServiceContext",
        "SimDeviceSet",
        "SimDevice",
        "SimRuntime",
        "SimDeviceType",
        // SimulatorKit — Swift classes use mangled names
        "_TtC12SimulatorKit24SimDeviceLegacyHIDClient",
        "_TtC12SimulatorKit16SimHIDClientBase",
        "_TtC12SimulatorKit22SimDeviceHIDIOSurface",
        "_TtC12SimulatorKit13SimHIDSession",
        "SimDigitizerInputView",
        "SimDisplayManager",
        "SimDisplayDescriptor",
    ]

    var matched = 0
    for name in knownNames {
        guard let cls = NSClassFromString(name) else {
            print("  ⚠️  \(name) — not found (class not registered)")
            continue
        }
        matched += 1

        print("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
        print("CLASS: \(name)")
        if let superCls = class_getSuperclass(cls) {
            print("  Superclass: \(String(cString: class_getName(superCls)))")
        }

        let instMethods = methodNames(of: cls)
        if !instMethods.isEmpty {
            print("  Instance methods (\(instMethods.count)):")
            instMethods.sorted().forEach { print("    - \($0)") }
        }

        let clsMethods = classMethodNames(of: cls)
        if !clsMethods.isEmpty {
            print("  Class methods (\(clsMethods.count)):")
            clsMethods.sorted().forEach { print("    + \($0)") }
        }
    }

    print("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("Found \(matched)/\(knownNames.count) targeted class(es).")
    print("")
    print("ℹ️  Note: Full objc_copyClassList enumeration (~60 k classes) hangs")
    print("   due to Swift runtime realization. Use NSClassFromString for any")
    print("   additional classes you want to inspect.")
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - CoreSimulator device lookup
// ──────────────────────────────────────────────────────────────────────────────

/// Locate a SimDevice by UDID using SimServiceContext → defaultDeviceSet → devices.
///
/// Returns the SimDevice as an `AnyObject` (opaque ObjC class instance), or nil
/// if the device cannot be found. Diagnostic output is printed throughout.
func findSimDevice(udid: String) -> AnyObject? {
    // ── 1. Get SimServiceContext shared instance ──────────────────────────────
    guard let ctxClass = NSClassFromString("SimServiceContext") else {
        fputs("❌ SimServiceContext class not found — CoreSimulator not loaded?\n", stderr)
        return nil
    }
    print("🔍 Found SimServiceContext class: \(ctxClass)")

    // +sharedServiceContextForDeveloperDir:error:
    let developerDir = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
        ?? "/Applications/Xcode.app/Contents/Developer"
    print("🔍 Using DEVELOPER_DIR: \(developerDir)")

    let sharedCtxSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
    guard let sharedCtxMethod = class_getClassMethod(ctxClass, sharedCtxSel) else {
        fputs("❌ SimServiceContext does not have sharedServiceContextForDeveloperDir:error:\n", stderr)
        let altMethods = classMethodNames(of: ctxClass)
        print("  Available class methods: \(altMethods.joined(separator: ", "))")
        return nil
    }

    // IMP: +[SimServiceContext sharedServiceContextForDeveloperDir:error:]
    // -> SimServiceContext?
    typealias SharedContextFn = @convention(c) (
        AnyClass,
        Selector,
        NSString,
        AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    let sharedContextImpl = unsafeBitCast(
        method_getImplementation(sharedCtxMethod),
        to: SharedContextFn.self
    )
    var contextError: NSError? = nil
    guard let serviceContext = sharedContextImpl(
        ctxClass,
        sharedCtxSel,
        developerDir as NSString,
        &contextError
    ) else {
        fputs("❌ sharedServiceContextForDeveloperDir: returned nil", stderr)
        if let err = contextError {
            fputs(" — \(err.localizedDescription)\n", stderr)
        } else {
            fputs("\n", stderr)
        }
        return nil
    }
    print("✅ Got SimServiceContext: \(serviceContext)")

    // ── 2. Get defaultDeviceSet ───────────────────────────────────────────────
    let defaultSetSel = NSSelectorFromString("defaultDeviceSetWithError:")
    let serviceContextClass: AnyClass = type(of: serviceContext)
    guard let defaultSetMethod = class_getInstanceMethod(serviceContextClass, defaultSetSel) else {
        fputs("❌ SimServiceContext does not respond to defaultDeviceSetWithError:\n", stderr)
        let instMethods = methodNames(of: serviceContextClass)
        print("  Available instance methods (first 30): \(instMethods.prefix(30).joined(separator: ", "))")
        return nil
    }

    typealias DefaultSetFn = @convention(c) (
        AnyObject,
        Selector,
        AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    let defaultSetImpl = unsafeBitCast(
        method_getImplementation(defaultSetMethod),
        to: DefaultSetFn.self
    )
    var setError: NSError? = nil
    guard let deviceSet = defaultSetImpl(serviceContext, defaultSetSel, &setError) else {
        fputs("❌ defaultDeviceSetWithError: returned nil", stderr)
        if let err = setError {
            fputs(" — \(err.localizedDescription)\n", stderr)
        } else {
            fputs("\n", stderr)
        }
        return nil
    }
    print("✅ Got SimDeviceSet: \(deviceSet)")

    // ── 3. Get devices dictionary via devicesByUDID (keyed by NSUUID) ────────────
    //
    // IMPORTANT: The keys in this dictionary are NSUUID objects, NOT NSString.
    // Searching by string equality silently misses every entry.
    // We must construct an NSUUID from the caller's udid string and use it
    // as the dictionary key directly.
    let byUDIDSel = NSSelectorFromString("devicesByUDID")
    guard let devicesObj = objcCall(deviceSet, sel: byUDIDSel) else {
        fputs("❌ SimDeviceSet.devicesByUDID returned nil\n", stderr)
        return nil
    }

    guard let devicesDict = devicesObj as? NSDictionary else {
        fputs("❌ Could not cast devicesByUDID result to NSDictionary; type=\(type(of: devicesObj))\n", stderr)
        return nil
    }
    print("  devicesByUDID count: \(devicesDict.count)")

    // Build an NSUUID key from the provided UDID string.
    guard let swiftUUID = UUID(uuidString: udid) else {
        fputs("❌ '\(udid)' is not a valid UUID string.\n", stderr)
        return nil
    }
    let nsUUID = swiftUUID as NSUUID

    if let found = devicesDict[nsUUID] {
        let device = found as AnyObject
        print("✅ Found SimDevice for UDID \(udid): \(device)")
        return device
    }

    fputs("❌ Device with UDID \(udid) not found in devicesByUDID.\n", stderr)
    let availableUDIDs = devicesDict.allKeys.map { String(describing: $0) }.joined(separator: "\n    ")
    print("  Available UDIDs:\n    \(availableUDIDs)")
    return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - SimDeviceLegacyHIDClient creation
// ──────────────────────────────────────────────────────────────────────────────

/// Create a SimDeviceLegacyHIDClient for the given SimDevice.
///
/// SimDeviceLegacyHIDClient is a Swift class in SimulatorKit.
/// Its ObjC-visible name is `_TtC12SimulatorKit24SimDeviceLegacyHIDClient`.
/// Initializer: init(device: SimDevice) throws
///
/// Returns the HID client as AnyObject, or nil on failure.
func createHIDClient(for device: AnyObject) -> AnyObject? {
    // The Swift-mangled ObjC class name for SimDeviceLegacyHIDClient.
    // Swift classes get an ObjC name of the form _TtC<module-len><module><class-len><class>.
    let possibleNames = [
        "_TtC12SimulatorKit24SimDeviceLegacyHIDClient",
        "SimDeviceLegacyHIDClient",
    ]

    var hidClientClass: AnyClass? = nil
    for name in possibleNames {
        if let cls = NSClassFromString(name) {
            hidClientClass = cls
            print("✅ Found SimDeviceLegacyHIDClient class as: \(name)")
            break
        }
    }

    guard let cls = hidClientClass else {
        fputs("❌ SimDeviceLegacyHIDClient class not found.\n", stderr)
        fputs("   Tried: \(possibleNames.joined(separator: ", "))\n", stderr)
        return nil
    }

    let instMethods = methodNames(of: cls)
    print("  HIDClient instance methods: \(instMethods.joined(separator: ", "))")
    let clsMethodsList = classMethodNames(of: cls)
    print("  HIDClient class methods: \(clsMethodsList.joined(separator: ", "))")

    // ── Allocate via +alloc using IMP ─────────────────────────────────────────
    let allocSel = NSSelectorFromString("alloc")
    guard let allocMethod = class_getClassMethod(cls, allocSel) else {
        fputs("❌ Cannot find +alloc on SimDeviceLegacyHIDClient\n", stderr)
        return nil
    }
    typealias AllocFn = @convention(c) (AnyClass, Selector) -> AnyObject
    let allocImpl = unsafeBitCast(method_getImplementation(allocMethod), to: AllocFn.self)
    let alloc: AnyObject = allocImpl(cls, allocSel)
    print("  Allocated instance: \(alloc)")

    // ── Try -initWithDevice:error: ────────────────────────────────────────────
    let initErrSel = NSSelectorFromString("initWithDevice:error:")
    if let initMethod = class_getInstanceMethod(cls, initErrSel) {
        typealias InitErrFn = @convention(c) (
            AnyObject,
            Selector,
            AnyObject,
            AutoreleasingUnsafeMutablePointer<NSError?>
        ) -> AnyObject?
        let initImpl = unsafeBitCast(method_getImplementation(initMethod), to: InitErrFn.self)
        var initError: NSError? = nil
        let client = initImpl(alloc, initErrSel, device, &initError)
        if let err = initError {
            fputs("❌ SimDeviceLegacyHIDClient initWithDevice:error: error: \(err.localizedDescription)\n", stderr)
            return nil
        }
        if let c = client {
            print("✅ Created SimDeviceLegacyHIDClient: \(c)")
            return c
        }
        fputs("⚠️  initWithDevice:error: returned nil (no error)\n", stderr)
    }

    // ── Try -initWithDevice: (no error) ──────────────────────────────────────
    let initSimpleSel = NSSelectorFromString("initWithDevice:")
    if let initSimpleMethod = class_getInstanceMethod(cls, initSimpleSel) {
        typealias InitSimpleFn = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        let initSimpleImpl = unsafeBitCast(method_getImplementation(initSimpleMethod), to: InitSimpleFn.self)
        if let c = initSimpleImpl(alloc, initSimpleSel, device) {
            print("✅ Created SimDeviceLegacyHIDClient (simple init): \(c)")
            return c
        }
        fputs("⚠️  initWithDevice: returned nil\n", stderr)
    }

    fputs("❌ No usable initializer found on SimDeviceLegacyHIDClient.\n", stderr)
    fputs("   Known instance selectors: \(instMethods.joined(separator: ", "))\n", stderr)
    return nil
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - IndigoHID touch injection
// ──────────────────────────────────────────────────────────────────────────────

/// ButtonEventType raw values passed to IndigoHIDMessageForMouseNSEvent as x3.
/// These happen to match the NSEventType values for left-mouse down/up (1 and 2).
let kButtonEventTypeDown: UInt = 1
let kButtonEventTypeUp: UInt   = 2

/// IndigoHID target for the pointer/trackpad service (subtype=3).
/// NOT used for touch injection — routes through a broken RelativePointerEvent path.
let kIndigoHIDTargetPointer: UInt = 0x35

/// IndigoHID target for the main iPhone screen touch service.
///
/// TARGET ID DETERMINATION (from SimulatorKit digitizerTarget getter):
///   screenType 0 (main iPhone/iPad): targetID = 0x32 (50)
///   screenType 3/4/5+ (CarPlay, external): targetID = screenID | 0x40000000
///
/// SimulatorHID pre-registers mainScreenTouchService at allServices[@(0x32)]
/// during initWithEventSystem:. No registration message needed — the service
/// exists from boot with a fully-configured event callback via
/// SimHIDMainScreenTouchServiceCallbackProvider.
let kIndigoHIDTargetDigitizer: UInt = 0x32

/// IndigoHID target for hardware button events on iPhone/iPad.
/// From SimDeviceScreen.buttonTarget getter in SimulatorKit.
let kIndigoHIDTargetButton: UInt32 = 0x33

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - USB HID usage codes
// ──────────────────────────────────────────────────────────────────────────────

/// Map browser KeyboardEvent.key names → USB HID Keyboard/Keypad usage codes.
/// Reference: USB HID Usage Tables, Section 10 (Keyboard/Keypad Page 0x07).
let kUSBHIDUsageCodes: [String: UInt32] = [
    // Letters (a-z)
    "a": 0x04, "b": 0x05, "c": 0x06, "d": 0x07, "e": 0x08,
    "f": 0x09, "g": 0x0A, "h": 0x0B, "i": 0x0C, "j": 0x0D,
    "k": 0x0E, "l": 0x0F, "m": 0x10, "n": 0x11, "o": 0x12,
    "p": 0x13, "q": 0x14, "r": 0x15, "s": 0x16, "t": 0x17,
    "u": 0x18, "v": 0x19, "w": 0x1A, "x": 0x1B, "y": 0x1C,
    "z": 0x1D,
    // Uppercase letters (same usage code — modifier handles shift)
    "A": 0x04, "B": 0x05, "C": 0x06, "D": 0x07, "E": 0x08,
    "F": 0x09, "G": 0x0A, "H": 0x0B, "I": 0x0C, "J": 0x0D,
    "K": 0x0E, "L": 0x0F, "M": 0x10, "N": 0x11, "O": 0x12,
    "P": 0x13, "Q": 0x14, "R": 0x15, "S": 0x16, "T": 0x17,
    "U": 0x18, "V": 0x19, "W": 0x1A, "X": 0x1B, "Y": 0x1C,
    "Z": 0x1D,
    // Numbers (0-9)
    "1": 0x1E, "2": 0x1F, "3": 0x20, "4": 0x21, "5": 0x22,
    "6": 0x23, "7": 0x24, "8": 0x25, "9": 0x26, "0": 0x27,
    // Special keys
    "Enter": 0x28, "Return": 0x28,
    "Escape": 0x29,
    "Backspace": 0x2A, "Delete": 0x4C,  // Backspace=0x2A, Forward Delete=0x4C
    "Tab": 0x2B,
    " ": 0x2C,  // Space
    // Punctuation
    "-": 0x2D, "=": 0x2E, "[": 0x2F, "]": 0x30,
    "\\": 0x31, ";": 0x33, "'": 0x34, "`": 0x35,
    ",": 0x36, ".": 0x37, "/": 0x38,
    // Arrow keys
    "ArrowRight": 0x4F, "ArrowLeft": 0x50,
    "ArrowDown": 0x51, "ArrowUp": 0x52,
    // Function keys
    "Home": 0x4A, "End": 0x4D,
    "PageUp": 0x4B, "PageDown": 0x4E,
]

/// Attempt to inject a single tap (down + up) at the given normalised coordinates
/// using IndigoHIDMessageForMouseNSEvent and SimDeviceLegacyHIDClient.send(message:).
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance (AnyObject).
///   - normX:     Normalised X coordinate (0.0 = left, 1.0 = right).
///   - normY:     Normalised Y coordinate (0.0 = top,  1.0 = bottom).
func injectTap(hidClient: AnyObject, normX: Double, normY: Double) {
    // ── 1. Resolve IndigoHIDMessageForMouseNSEvent via dlsym ─────────────────
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not currently loaded — cannot dlsym\n", stderr)
        return
    }
    defer { dlclose(simKitHandle) }

    guard let rawIndigoPtr = dlsym(simKitHandle, "IndigoHIDMessageForMouseNSEvent") else {
        fputs("❌ dlsym(IndigoHIDMessageForMouseNSEvent) failed: \(String(cString: dlerror()))\n", stderr)
        return
    }
    let indigoFn = unsafeBitCast(rawIndigoPtr, to: IndigoHIDMessageForMouseNSEventFn.self)

    // ── 2. Resolve the correct send selector on the HIDClient ────────────────
    //
    // The correct ObjC-bridged selector (confirmed via disassembly / test_hid6)
    // is `sendWithMessage:freeWhenDone:completionQueue:completion:`.
    // Earlier guesses ("sendMessage:", "send:", "sendWithMessage:") are all wrong.
    let clientClass: AnyClass = type(of: hidClient)
    let instMethods = methodNames(of: clientClass)

    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to \(sendSelName)\n", stderr)
        fputs("   Available methods: \(instMethods.joined(separator: ", "))\n", stderr)
        return
    }

    // ── 3. No registration needed ──────────────────────────────────────────────
    //
    // SimulatorHID pre-registers the main screen touch service at
    // allServices[@(0x32)] during initWithEventSystem:. Sending registration
    // messages (CreatePointerService, CreateMouseService, CreateDigitizerService)
    // is unnecessary and could interfere with the pre-existing properly-configured
    // services. The pointer (0x35) and mouse (0x36) registrations are also
    // skipped as they are not needed for touch injection.

    // ── 4. Send touch-down ─────────────────────────────────────────────────────
    sendTouchEventViaObjC(
        hidClient: hidClient,
        sendSel: sendSel,
        sendMethod: sendMethod,
        indigoFn: indigoFn,
        x: normX, y: normY,
        eventType: kButtonEventTypeDown
    )

    Thread.sleep(forTimeInterval: 0.05)

    // ── 5. Send touch-up ───────────────────────────────────────────────────────
    sendTouchEventViaObjC(
        hidClient: hidClient,
        sendSel: sendSel,
        sendMethod: sendMethod,
        indigoFn: indigoFn,
        x: normX, y: normY,
        eventType: kButtonEventTypeUp
    )
    print("✅ Tap injection complete.")
}

/// Send an IndigoHID registration message to register a HID service in the
/// simulator's backboardd process.  Without this, `serviceForIndigoHIDData:`
/// cannot find any service for the target and crashes with SIGABRT.
///
/// Registration message wire format (from reverse-engineering SimulatorKit):
///   +0x18 (u32)   = element_data_size = 0xa0
///   +0x1c (u8)    = flag = 0x01
///   +0x20 (u32)   = message type = 0x7fff0001 (registration)
///   +0x30 (u32)   = subtype (3=CreatePointer, 5=CreateMouse, 1=CreateDigitizer)
///   +0x40 (u32)   = targetID
///   Total size: 0xc0 (192 bytes)
///
/// - Parameters:
///   - hidClient:  The SimDeviceLegacyHIDClient instance.
///   - sendSel:    The resolved send selector.
///   - sendMethod: The Method for the send selector.
///   - subtype:    Registration subtype (3=CreatePointer, 5=CreateMouse).
///   - targetID:   The HID target identifier to register (e.g. 0x35 for pointer).
private func sendRegistrationMessage(
    hidClient: AnyObject,
    sendSel: Selector,
    sendMethod: Method,
    subtype: UInt32,
    targetID: UInt32
) {
    let buf = calloc(1, 0xc0)!

    // Write fields at their exact byte offsets
    buf.storeBytes(of: UInt32(0xa0),       toByteOffset: 0x18, as: UInt32.self)  // element_data_size
    buf.storeBytes(of: UInt8(0x01),        toByteOffset: 0x1c, as: UInt8.self)   // flag
    buf.storeBytes(of: UInt32(0x7fff0001), toByteOffset: 0x20, as: UInt32.self)  // message type = registration
    buf.storeBytes(of: subtype,            toByteOffset: 0x30, as: UInt32.self)  // subtype
    buf.storeBytes(of: targetID,           toByteOffset: 0x40, as: UInt32.self)  // targetID

    typealias SendFn = @convention(c) (
        AnyObject,               // self
        Selector,                // _cmd
        UnsafeMutableRawPointer, // message
        Bool,                    // freeWhenDone
        AnyObject?,              // completionQueue
        AnyObject?               // completion
    ) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)
    sendFn(hidClient, sendSel, buf, true, nil, nil)
    // freeWhenDone:true — framework takes ownership
}

/// Send an IndigoHID digitizer registration message (subtype=1) to register
/// the screen touch digitizer service in backboardd's allServices dictionary.
///
/// Wire format (confirmed from SimulatorHID block_invoke disassembly):
///   +0x18 (u32)       = element_data_size = 0xa0
///   +0x1c (u8)        = flag = 0x01
///   +0x20 (u32)       = message type = 0x7fff0001 (registration)
///   +0x30 (u32)       = subtype = 1 (createDigitizer)
///   +0x40 (u32)       = targetID (must have bit 30 set, e.g. 0x40000000)
///   +0x44 (c-string)  = displayUID, null-terminated UTF-8, max 63 chars
///                       = "PurpleMain" for the main iPhone screen
///   Total size: 0xc0 (192 bytes)
private func sendDigitizerRegistrationMessage(
    hidClient: AnyObject,
    sendSel: Selector,
    sendMethod: Method,
    targetID: UInt32,
    displayUID: String
) {
    let buf = calloc(1, 0xc0)!

    buf.storeBytes(of: UInt32(0xa0),       toByteOffset: 0x18, as: UInt32.self)
    buf.storeBytes(of: UInt8(0x01),        toByteOffset: 0x1c, as: UInt8.self)
    buf.storeBytes(of: UInt32(0x7fff0001), toByteOffset: 0x20, as: UInt32.self)
    buf.storeBytes(of: UInt32(1),          toByteOffset: 0x30, as: UInt32.self)  // subtype = CreateDigitizer
    buf.storeBytes(of: targetID,           toByteOffset: 0x40, as: UInt32.self)

    // Write displayUID as null-terminated UTF-8 at offset 0x44, max 63 chars
    let uidBytes = Array(displayUID.utf8.prefix(63))
    for (i, byte) in uidBytes.enumerated() {
        buf.storeBytes(of: byte, toByteOffset: 0x44 + i, as: UInt8.self)
    }
    // null terminator already present from calloc zeroing

    typealias SendFn = @convention(c) (
        AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?
    ) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)
    sendFn(hidClient, sendSel, buf, true, nil, nil)
}

/// Normalised (x, y) coordinate pair passed as x0 to IndigoHIDMessageForMouseNSEvent.
///
/// The first argument of IndigoHIDMessageForMouseNSEvent is a pointer to this struct
/// (NOT nil as originally assumed). Passing nil causes a SIGSEGV.
struct TouchCoords {
    var x: Double
    var y: Double
}

/// Build one IndigoHID message and dispatch it via the HIDClient.
///
/// - Parameters:
///   - hidClient:   The `SimDeviceLegacyHIDClient` instance.
///   - sendSel:     The resolved `sendWithMessage:freeWhenDone:completionQueue:completion:` selector.
///   - sendMethod:  The `Method` for that selector (already looked up by the caller).
///   - indigoFn:    Resolved `IndigoHIDMessageForMouseNSEvent` function pointer.
///   - x:           Normalised x coordinate (0–1).
///   - y:           Normalised y coordinate (0–1).
///   - eventType:   ButtonEventType raw value (1 = down, 2 = up).
private func sendTouchEventViaObjC(
    hidClient: AnyObject,
    sendSel: Selector,
    sendMethod: Method,
    indigoFn: IndigoHIDMessageForMouseNSEventFn,
    x: Double, y: Double,
    eventType: UInt
) {
    // Build the coords struct on the stack and pass a pointer to it as x0 (point0).
    // x1 (point1) = nil  — single touch, no secondary point.
    // x2 (target) = 0x40000000 — digitizer touch screen target (bit 30 set).
    // x3 (eventType) = 1 (down) or 2 (up).
    // d0/d1 (size) = 1.0, 1.0 — scale divisors (normalised coords need no scaling).
    // x4 (edge) = 0 — no edge flags.
    var coords = TouchCoords(x: x, y: y)
    let msgPtr = withUnsafeMutablePointer(to: &coords) { coordsPtr in
        indigoFn(coordsPtr, nil, kIndigoHIDTargetDigitizer, eventType, 1.0, 1.0, 0)
    }

    guard let msg = msgPtr else {
        fputs("⚠️  IndigoHIDMessageForMouseNSEvent returned nil (eventType=\(eventType))\n", stderr)
        return
    }
    // PATCH: IndigoHIDMessageForMouseNSEvent hardcodes phase=2 (kIOHIDPhaseChanged)
    // at buf+0x74 for ALL event types.  The touch state machine requires:
    //   Began(1) → Changed(2)* → Ended(4)
    // Without this patch, events are silently dropped (no preceding Began).
    let correctPhase: UInt32
    switch eventType {
    case kButtonEventTypeDown: correctPhase = 1  // kIOHIDPhaseBegan
    case kButtonEventTypeUp:   correctPhase = 4  // kIOHIDPhaseEnded
    default:                   correctPhase = 2  // kIOHIDPhaseChanged
    }
    msg.storeBytes(of: correctPhase, toByteOffset: 0x74, as: UInt32.self)
    // NOTE: freeWhenDone is passed as `false` to the send call below, so the
    // framework keeps ownership of the message buffer — do NOT free(msg) here.

    // IMP for sendWithMessage:freeWhenDone:completionQueue:completion:
    // Parameters (after self + _cmd):
    //   message        (UnsafeMutableRawPointer)
    //   freeWhenDone   (Bool / ObjC BOOL)
    //   completionQueue (DispatchQueue? bridged as AnyObject?)
    //   completion      (block / AnyObject?)
    typealias SendFn = @convention(c) (
        AnyObject,              // self
        Selector,               // _cmd
        UnsafeMutableRawPointer, // message
        Bool,                   // freeWhenDone
        AnyObject?,             // completionQueue
        AnyObject?              // completion
    ) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)
    sendFn(hidClient, sendSel, msg, false, nil, nil)
}

/// Fallback: find and call the Swift dispatch thunk for
/// SimDeviceLegacyHIDClient.send(message:) directly via dlsym of the
/// Swift-mangled symbol.
///
/// The Swift mangled name is:
///   $s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tFTj
/// (dispatch thunk of SimulatorKit.SimDeviceLegacyHIDClient.send(message:))
private func attemptSwiftDirectCall(
    hidClient: AnyObject,
    indigoFn: IndigoHIDMessageForMouseNSEventFn,
    normX: Double,
    normY: Double
) {
    let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD)
    defer { if let h = simKitHandle { dlclose(h) } }

    // Mangle: SimulatorKit.SimDeviceLegacyHIDClient.send(message:) dispatch thunk
    let mangledName = "$s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tFTj"
    guard let fnPtr = dlsym(simKitHandle, mangledName) else {
        fputs("❌ dlsym for Swift mangled send(message:) failed: \(String(cString: dlerror()))\n", stderr)
        fputs("   Mangled name attempted: \(mangledName)\n", stderr)
        return
    }
    print("✅ Found Swift send(message:) dispatch thunk at \(fnPtr)")

    // The Swift dispatch thunk has the following calling convention:
    // arg0 (x0) = UnsafeMutablePointer<IndigoHIDMessageStruct>
    // self (x20) = SimDeviceLegacyHIDClient (Swift self register, arm64e ABI)
    //
    // Since we can't pass Swift's `self` register from C calling convention,
    // we use a workaround: call the underlying implementation directly.
    // Try the non-thunk symbol first:
    let implMangledName = "$s12SimulatorKit24SimDeviceLegacyHIDClientC4send7messageySpySo22IndigoHIDMessageStructVG_tF"
    let implFnPtr = dlsym(simKitHandle, implMangledName) ?? fnPtr
    print("  Using impl at \(implFnPtr)")

    let events: [(UInt, String)] = [
        (kButtonEventTypeDown, "touch-down"),
        (kButtonEventTypeUp,   "touch-up"),
    ]

    for (eventType, label) in events {
        if label == "touch-up" { Thread.sleep(forTimeInterval: 0.05) }

        guard let msgPtr = indigoFn(nil, nil, kIndigoHIDTargetDigitizer, eventType, 1.0, 1.0, 0) else {
            fputs("⚠️  IndigoHIDMessageForMouseNSEvent returned nil for \(label)\n", stderr)
            continue
        }
        defer { free(msgPtr) }
        print("📤 Swift direct: \(label) at (\(normX), \(normY))…")

        // Attempt: cast the thunk to a C function that takes (message_ptr, self).
        // NOTE: This may crash if the ABI assumption is wrong; it's a best-effort.
        // On arm64e, Swift methods use x20 for self, but many thunks accept
        // self as an extra trailing argument — behaviour depends on exact thunk.
        typealias SwiftSendFn = @convention(c) (UnsafeMutableRawPointer, AnyObject) -> Void
        let sendFn = unsafeBitCast(implFnPtr, to: SwiftSendFn.self)
        sendFn(msgPtr, hidClient)
        print("   Swift direct send called for \(label).")
    }
    print("✅ Swift direct call tap injection attempt complete.")
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Keyboard injection
// ──────────────────────────────────────────────────────────────────────────────

/// Inject a keyboard event (key down + key up) for a single key.
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance.
///   - keyName:   Key name (e.g. "a", "Enter", "Backspace", "ArrowUp").
func injectKeyEvent(hidClient: AnyObject, keyName: String) {
    guard let usageCode = kUSBHIDUsageCodes[keyName] else {
        fputs("❌ Unknown key name: \"\(keyName)\" — not in USB HID usage table\n", stderr)
        exit(1)
    }

    // Resolve function
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\n", stderr)
        return
    }
    defer { dlclose(simKitHandle) }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForKeyboardArbitrary") else {
        fputs("❌ dlsym(IndigoHIDMessageForKeyboardArbitrary) failed\n", stderr)
        return
    }
    let keyFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForKeyboardArbitraryFn.self)

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\n", stderr)
        return
    }

    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    // Key down
    guard let msgDown = keyFn(usageCode, 1) else {
        fputs("❌ IndigoHIDMessageForKeyboardArbitrary returned nil for key down\n", stderr)
        return
    }
    sendFn(hidClient, sendSel, msgDown, false, nil, nil)

    Thread.sleep(forTimeInterval: 0.02)

    // Key up
    guard let msgUp = keyFn(usageCode, 2) else {
        fputs("❌ IndigoHIDMessageForKeyboardArbitrary returned nil for key up\n", stderr)
        return
    }
    sendFn(hidClient, sendSel, msgUp, false, nil, nil)

    print("✅ Key event sent: \"\(keyName)\" (USB HID 0x\(String(usageCode, radix: 16)))")
}

/// Inject a text string as a series of key events.
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance.
///   - text:      The text to type.
func injectTextInput(hidClient: AnyObject, text: String) {
    // Resolve function
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\n", stderr)
        return
    }
    defer { dlclose(simKitHandle) }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForKeyboardArbitrary") else {
        fputs("❌ dlsym(IndigoHIDMessageForKeyboardArbitrary) failed\n", stderr)
        return
    }
    let keyFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForKeyboardArbitraryFn.self)

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\n", stderr)
        return
    }

    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    for char in text {
        let charStr = String(char)
        guard let usageCode = kUSBHIDUsageCodes[charStr] else {
            fputs("⚠️  Skipping unsupported character: \"\(charStr)\"\n", stderr)
            continue
        }

        // Key down
        if let msgDown = keyFn(usageCode, 1) {
            sendFn(hidClient, sendSel, msgDown, false, nil, nil)
        }

        Thread.sleep(forTimeInterval: 0.01)

        // Key up
        if let msgUp = keyFn(usageCode, 2) {
            sendFn(hidClient, sendSel, msgUp, false, nil, nil)
        }

        Thread.sleep(forTimeInterval: 0.01)
    }

    print("✅ Text input sent: \"\(text.prefix(50))\(text.count > 50 ? "…" : "")\" (\(text.count) chars)")
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Swipe injection
// ──────────────────────────────────────────────────────────────────────────────

/// Inject a swipe gesture from one normalised coordinate to another.
///
/// Uses a Began → Changed* → Ended phase sequence with interpolated coordinates.
///
/// - Parameters:
///   - hidClient: The SimDeviceLegacyHIDClient instance.
///   - fromX, fromY: Start coordinates (normalised 0.0–1.0).
///   - toX, toY:     End coordinates (normalised 0.0–1.0).
///   - steps:        Number of intermediate move events (default 10).
///   - durationMs:   Total swipe duration in milliseconds (default 300).
func injectSwipe(
    hidClient: AnyObject,
    fromX: Double, fromY: Double,
    toX: Double, toY: Double,
    steps: Int = 10,
    durationMs: Int = 300
) {
    // Resolve IndigoHIDMessageForMouseNSEvent
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\n", stderr)
        return
    }
    defer { dlclose(simKitHandle) }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForMouseNSEvent") else {
        fputs("❌ dlsym(IndigoHIDMessageForMouseNSEvent) failed\n", stderr)
        return
    }
    let indigoFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForMouseNSEventFn.self)

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\n", stderr)
        return
    }

    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    let stepDelay = Double(durationMs) / 1000.0 / Double(steps)

    // Helper to send a single touch event with proper phase patching
    func sendTouch(x: Double, y: Double, eventType: UInt, phase: UInt32) {
        var coords = TouchCoords(x: x, y: y)
        guard let msg = withUnsafeMutablePointer(to: &coords, { ptr in
            indigoFn(ptr, nil, kIndigoHIDTargetDigitizer, eventType, 1.0, 1.0, 0)
        }) else {
            fputs("⚠️  IndigoHIDMessageForMouseNSEvent returned nil\n", stderr)
            return
        }
        // Patch phase field (same fix as injectTap)
        msg.storeBytes(of: phase, toByteOffset: 0x74, as: UInt32.self)
        sendFn(hidClient, sendSel, msg, false, nil, nil)
    }

    // ── 1. Touch down at start (Began) ──
    sendTouch(x: fromX, y: fromY, eventType: kButtonEventTypeDown, phase: 1)

    // ── 2. Intermediate moves (Changed) ──
    for i in 1...steps {
        Thread.sleep(forTimeInterval: stepDelay)
        let t = Double(i) / Double(steps)
        let x = fromX + (toX - fromX) * t
        let y = fromY + (toY - fromY) * t
        // For move events, use eventType=down (1) with phase=Changed (2)
        sendTouch(x: x, y: y, eventType: kButtonEventTypeDown, phase: 2)
    }

    // ── 3. Touch up at end (Ended) ──
    Thread.sleep(forTimeInterval: 0.01)
    sendTouch(x: toX, y: toY, eventType: kButtonEventTypeUp, phase: 4)

    print("✅ Swipe sent: (\(fromX), \(fromY)) → (\(toX), \(toY)) in \(steps) steps over \(durationMs)ms")
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Button injection
// ──────────────────────────────────────────────────────────────────────────────

/// Inject a hardware button press (down + up).
///
/// - Parameters:
///   - hidClient:  The SimDeviceLegacyHIDClient instance.
///   - buttonName: Button name: "home", "lock", "volumeUp", "volumeDown".
func injectButton(hidClient: AnyObject, buttonName: String) {
    let buttonCodes: [String: UInt32] = [
        "home":       1,
        "lock":       2002,
        "volumeUp":   2001,
        "volumeDown": 2000,
    ]

    guard let buttonCode = buttonCodes[buttonName] else {
        fputs("❌ Unknown button: \"\(buttonName)\". Valid: home, lock, volumeUp, volumeDown\n", stderr)
        exit(1)
    }

    // Resolve function
    guard let simKitHandle = dlopen(kSimulatorKitPath, RTLD_NOLOAD) else {
        fputs("❌ SimulatorKit not loaded\n", stderr)
        return
    }
    defer { dlclose(simKitHandle) }

    guard let rawPtr = dlsym(simKitHandle, "IndigoHIDMessageForButton") else {
        fputs("❌ dlsym(IndigoHIDMessageForButton) failed\n", stderr)
        return
    }
    let buttonFn = unsafeBitCast(rawPtr, to: IndigoHIDMessageForButtonFn.self)

    // Resolve send method
    let clientClass: AnyClass = type(of: hidClient)
    let sendSelName = "sendWithMessage:freeWhenDone:completionQueue:completion:"
    let sendSel = NSSelectorFromString(sendSelName)
    guard hidClient.responds(to: sendSel),
          let sendMethod = class_getInstanceMethod(clientClass, sendSel) else {
        fputs("❌ HIDClient does not respond to send selector\n", stderr)
        return
    }

    typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, AnyObject?, AnyObject?) -> Void
    let sendFn = unsafeBitCast(method_getImplementation(sendMethod), to: SendFn.self)

    // Button down
    guard let msgDown = buttonFn(buttonCode, 1, kIndigoHIDTargetButton) else {
        fputs("❌ IndigoHIDMessageForButton returned nil for button down\n", stderr)
        return
    }
    sendFn(hidClient, sendSel, msgDown, false, nil, nil)

    Thread.sleep(forTimeInterval: 0.05)

    // Button up
    guard let msgUp = buttonFn(buttonCode, 2, kIndigoHIDTargetButton) else {
        fputs("❌ IndigoHIDMessageForButton returned nil for button up\n", stderr)
        return
    }
    sendFn(hidClient, sendSel, msgUp, false, nil, nil)

    print("✅ Button pressed: \"\(buttonName)\" (code \(buttonCode), target 0x\(String(kIndigoHIDTargetButton, radix: 16)))")
}

// ──────────────────────────────────────────────────────────────────────────────
// MARK: - Main entry point
// ──────────────────────────────────────────────────────────────────────────────

func printUsage() -> Never {
    fputs("""
    Usage:
      wms-indigo-poc --discover
          List SimulatorKit/CoreSimulator ObjC classes and their methods.

      wms-indigo-poc <udid> tap <normX> <normY>
          Inject a tap at normalised coordinates (0.0–1.0).

      wms-indigo-poc <udid> swipe <x1> <y1> <x2> <y2> [steps] [durationMs]
          Inject a swipe gesture between normalised coordinates.
          Default: 10 steps, 300ms duration.

      wms-indigo-poc <udid> key <keyName>
          Inject a single key press (down + up).
          Key names: a-z, 0-9, Enter, Backspace, Delete, Tab, Escape,
                     ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, etc.

      wms-indigo-poc <udid> type <text>
          Type a text string as a series of key events.

      wms-indigo-poc <udid> button <buttonName>
          Press a hardware button: home, lock, volumeUp, volumeDown.

    Examples:
      wms-indigo-poc --discover
      wms-indigo-poc ABCD-1234 tap 0.5 0.5
      wms-indigo-poc ABCD-1234 swipe 0.5 0.8 0.5 0.2
      wms-indigo-poc ABCD-1234 key Enter
      wms-indigo-poc ABCD-1234 type "hello world"
      wms-indigo-poc ABCD-1234 button home

    """, stderr)
    exit(1)
}

let args = CommandLine.arguments

guard args.count >= 2 else { printUsage() }

// ── Load frameworks first (required before any ObjC introspection) ────────────
print("──────────────────────────────────────────────────────────")
print("  WMS IndigoHID POC")
print("──────────────────────────────────────────────────────────")
loadFramework(kCoreSimulatorPath)
loadFramework(kSimulatorKitPath)
print("")

// ── Dispatch on command ───────────────────────────────────────────────────────
let command = args[1]

if command == "--discover" {
    print("🔍 Discovering SimulatorKit and CoreSimulator ObjC classes…\n")
    discoverClasses()
} else {
    // All other commands require: <udid> <command> [args...]
    guard args.count >= 3 else { printUsage() }
    let udid = command
    let subcommand = args[2]

    // Find device and create HID client (common for all commands)
    print("🎯 Target UDID: \(udid)\n")

    guard let device = findSimDevice(udid: udid) else {
        fputs("❌ Could not locate SimDevice — see diagnostics above.\n", stderr)
        exit(1)
    }

    if let nameVal = objcCall(device, sel: NSSelectorFromString("name")),
       let stateVal = objcCall(device, sel: NSSelectorFromString("stateString")) {
        print("  Device: \(nameVal) (\(stateVal))")
    }
    print("")

    guard let hidClient = createHIDClient(for: device) else {
        fputs("❌ Could not create SimDeviceLegacyHIDClient.\n", stderr)
        exit(1)
    }
    print("")

    switch subcommand {
    case "tap":
        guard args.count >= 5,
              let normX = Double(args[3]), let normY = Double(args[4]),
              (0.0...1.0).contains(normX), (0.0...1.0).contains(normY) else {
            fputs("Usage: wms-indigo-poc <udid> tap <normX> <normY>\n", stderr)
            exit(1)
        }
        print("🎯 Tap at (\(normX), \(normY))")
        injectTap(hidClient: hidClient, normX: normX, normY: normY)

    case "swipe":
        guard args.count >= 7,
              let x1 = Double(args[3]), let y1 = Double(args[4]),
              let x2 = Double(args[5]), let y2 = Double(args[6]) else {
            fputs("Usage: wms-indigo-poc <udid> swipe <x1> <y1> <x2> <y2> [steps] [durationMs]\n", stderr)
            exit(1)
        }
        let steps = args.count >= 8 ? (Int(args[7]) ?? 10) : 10
        let durationMs = args.count >= 9 ? (Int(args[8]) ?? 300) : 300
        print("🎯 Swipe (\(x1),\(y1)) → (\(x2),\(y2)) steps=\(steps) duration=\(durationMs)ms")
        injectSwipe(hidClient: hidClient, fromX: x1, fromY: y1, toX: x2, toY: y2, steps: steps, durationMs: durationMs)

    case "key":
        guard args.count >= 4 else {
            fputs("Usage: wms-indigo-poc <udid> key <keyName>\n", stderr)
            exit(1)
        }
        let keyName = args[3]
        print("🎯 Key: \"\(keyName)\"")
        injectKeyEvent(hidClient: hidClient, keyName: keyName)

    case "type":
        guard args.count >= 4 else {
            fputs("Usage: wms-indigo-poc <udid> type <text>\n", stderr)
            exit(1)
        }
        let text = args[3]
        print("🎯 Type: \"\(text.prefix(50))\(text.count > 50 ? "…" : "")\"")
        injectTextInput(hidClient: hidClient, text: text)

    case "button":
        guard args.count >= 4 else {
            fputs("Usage: wms-indigo-poc <udid> button <home|lock|volumeUp|volumeDown>\n", stderr)
            exit(1)
        }
        let buttonName = args[3]
        print("🎯 Button: \"\(buttonName)\"")
        injectButton(hidClient: hidClient, buttonName: buttonName)

    default:
        fputs("❌ Unknown command: \(subcommand)\n", stderr)
        printUsage()
    }
}
