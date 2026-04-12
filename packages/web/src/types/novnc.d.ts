/**
 * TypeScript ambient declarations for @novnc/novnc.
 *
 * The @novnc/novnc package ships JavaScript without bundled type definitions.
 * These declarations provide minimal typings for the RFB class used by the
 * SimulatorViewerComponent.
 *
 * Compatible with @novnc/novnc ≥ 1.7.0-beta which uses ES modules and exports
 * the RFB class from `@novnc/novnc` (maps to `./core/rfb.js`).
 */

declare module '@novnc/novnc' {
  /** Options passed to the RFB constructor. */
  export interface RFBOptions {
    /** WebSocket subprotocols to request. Default: ['binary'] */
    wsProtocols?: string[];
    /** Credential details for authentication. */
    credentials?: {
      username?: string;
      password?: string;
      target?: string;
    };
    /** Whether to scale the viewport to the container size. */
    scaleViewport?: boolean;
    /** Whether the server should resize to match the client. */
    resizeSession?: boolean;
    /** Whether to show the dot cursor locally. */
    showDotCursor?: boolean;
    /** Background colour when no pixel data is available. */
    background?: string;
    /** Whether the clipboard should flow from server → client. */
    clipViewport?: boolean;
    /** Whether to enable drag scrolling. */
    dragViewport?: boolean;
    /** Whether to request a shared VNC connection. Default: true. */
    shared?: boolean;
    /** Repeater ID for UltraVNC repeaters. */
    repeaterID?: string;
    /** Whether input events (mouse, keyboard, touch) are forwarded. Default: false (input enabled). */
    viewOnly?: boolean;
    /** Whether clicking the canvas focuses it for keyboard capture. Default: true. */
    focusOnClick?: boolean;
    /** JPEG quality level for Tight encoding (0-9). Default: 6. */
    qualityLevel?: number;
    /** Compression level for encodings (0-9). Default: 2. */
    compressionLevel?: number;
  }

  /** Event fired when the connection is established. */
  export interface RFBConnectEvent extends CustomEvent {
    detail: Record<string, never>;
  }

  /** Event fired when the connection is torn down. */
  export interface RFBDisconnectEvent extends CustomEvent {
    detail: {
      /** Whether the disconnect was requested by the client (clean). */
      clean: boolean;
      /** Human-readable reason string when disconnection is not clean. */
      reason?: string;
    };
  }

  /** Event fired when the server reports a desktop name. */
  export interface RFBDesktopNameEvent extends CustomEvent {
    detail: { name: string };
  }

  /** Event fired when credentials are required to proceed. */
  export interface RFBCredentialsRequiredEvent extends CustomEvent {
    detail: { types: string[] };
  }

  /** Event fired when the remote desktop size changes. */
  export interface RFBDesktopSizeEvent extends CustomEvent {
    detail: { width: number; height: number };
  }

  /** RFB event map for addEventListener/removeEventListener. */
  export interface RFBEventMap {
    connect: RFBConnectEvent;
    disconnect: RFBDisconnectEvent;
    desktopname: RFBDesktopNameEvent;
    credentialsrequired: RFBCredentialsRequiredEvent;
    desktopsize: RFBDesktopSizeEvent;
    securityfailure: CustomEvent<{ status: number; reason?: string }>;
    clipboard: CustomEvent<{ text: string }>;
    bell: CustomEvent<Record<string, never>>;
    capabilities: CustomEvent<{ capabilities: Record<string, boolean> }>;
    clippingviewport: CustomEvent<{ viewport: DOMRect; desktop: { width: number; height: number } }>;
  }

  /**
   * Core RFB/VNC client class from noVNC.
   *
   * Manages the WebSocket connection, protocol negotiation, and rendering
   * into the provided container element.
   */
  class RFB {
    /**
     * Create a new RFB instance and begin connecting.
     * @param target The DOM element into which noVNC renders the canvas.
     * @param url    The WebSocket URL of the VNC server/proxy.
     * @param options Optional configuration.
     */
    constructor(target: HTMLElement, url: string, options?: RFBOptions);

    // ── Properties ───────────────────────────────────────────────────────────

    /** Whether to scale the viewport. */
    scaleViewport: boolean;
    /** Whether to clip the viewport. */
    clipViewport: boolean;
    /** Whether to enable drag scrolling. */
    dragViewport: boolean;
    /** Whether the session should resize to the client. */
    resizeSession: boolean;
    /** Whether to show the dot cursor when no remote cursor is available. */
    showDotCursor: boolean;
    /** Background fill colour. */
    background: string;
    /** Whether input events (mouse, keyboard, touch) are forwarded to the remote. Default: false. */
    viewOnly: boolean;
    /** Whether clicking the canvas focuses it for keyboard capture. Default: true. */
    focusOnClick: boolean;
    /** JPEG quality level for Tight encoding (0-9, higher = better quality). Default: 6. */
    qualityLevel: number;
    /** Compression level for encodings (0-9, higher = more compression). Default: 2. */
    compressionLevel: number;
    /** Server capabilities (e.g. whether XVP power management is supported). */
    readonly capabilities: { power: boolean };

    // ── Methods ───────────────────────────────────────────────────────────────

    /**
     * Disconnect from the server.
     */
    disconnect(): void;

    /** Send Ctrl-Alt-Delete to the remote. */
    sendCtrlAltDel(): void;

    /**
     * Provide credentials in response to a `credentialsrequired` event.
     * @param credentials Credential fields requested by the server.
     */
    sendCredentials(credentials: {
      username?: string;
      password?: string;
      target?: string;
    }): void;

    /**
     * Send a key event to the remote desktop.
     * @param keysym X11 key symbol.
     * @param code   DOM key code string (or null).
     * @param down   True for key-down, false for key-up.
     */
    sendKey(keysym: number, code: string | null, down?: boolean): void;

    /** Focus the VNC canvas element for keyboard input capture. */
    focus(options?: FocusOptions): void;

    /** Remove keyboard focus from the VNC canvas element. */
    blur(): void;

    /** Send clipboard text to the remote desktop. */
    clipboardPasteFrom(text: string): void;

    /** Request XVP machine shutdown (requires server support). */
    machineShutdown(): void;

    /** Request XVP machine reboot (requires server support). */
    machineReboot(): void;

    /** Request XVP machine reset (requires server support). */
    machineReset(): void;

    /**
     * Get the current canvas contents as ImageData.
     * @returns The ImageData for the current VNC frame.
     */
    getImageData(): ImageData;

    /**
     * Get the current canvas contents as a data: URL.
     * @param type MIME type (e.g. 'image/png'). Defaults to 'image/png'.
     * @param encoderOptions Quality for lossy formats (0-1).
     */
    toDataURL(type?: string, encoderOptions?: number): string;

    /**
     * Get the current canvas contents as a Blob, asynchronously.
     * @param callback Callback receiving the Blob.
     * @param type MIME type. Defaults to 'image/png'.
     * @param quality Quality for lossy formats (0-1).
     */
    toBlob(callback: BlobCallback, type?: string, quality?: number): void;

    // ── EventTarget interface ─────────────────────────────────────────────────

    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;

    removeEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (ev: RFBEventMap[K]) => void,
      options?: boolean | EventListenerOptions,
    ): void;
  }

  export default RFB;
}
