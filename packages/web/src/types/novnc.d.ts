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
