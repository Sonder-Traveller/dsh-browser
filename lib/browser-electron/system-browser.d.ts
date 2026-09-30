/**
 * Drive the browser the user already has (Chrome / Edge / any Chromium) instead of
 * the Electron we ship — the same approach Codex Browser Use takes.
 *
 * WHY
 * The bundled Electron is a private copy with its own profile, so it can never see
 * the logins the user already has in Chrome, and on a managed machine the user may
 * simply prefer their own browser. Launching their browser with a *separate*
 * `--user-data-dir` gives us a real Chromium we can drive over CDP without touching
 * their everyday profile, bookmarks or windows: nothing of theirs is opened, locked
 * or modified, and closing us never closes them.
 *
 * HOW
 * Chromium exposes CDP on `--remote-debugging-port=0`, and writes the port it chose
 * into `<profile>/DevToolsActivePort`. That file is the discovery mechanism — no
 * port guessing, no collisions. From there everything is CDP over one WebSocket:
 * `Target.createTarget` makes a page, `Target.attachToTarget` (flattened) gives a
 * session for it, and the plugin's commands ride that session. Node 22 ships a global
 * `WebSocket`, so this needs no dependency at all.
 *
 * WHAT IT IMPLEMENTS
 * The same `ElectronBrowserViewHost` seam as the self-hosted and sidebar hosts, so
 * the provider, the tools, history, the cursor and teardown rules are unchanged —
 * only the carrier differs.
 * @module dsh-browser/browser-electron/system-browser
 */
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
/** Which browser the user asked for. */
export type BrowserChannel = 'bundled' | 'chrome' | 'edge' | 'auto';
/** A resolved browser installation. */
export interface DetectedBrowser {
    /** Which product this is. */
    readonly kind: 'chrome' | 'edge' | 'brave';
    /** Absolute path to the executable. */
    readonly path: string;
}
/**
 * Find an installed Chromium browser.
 *
 * `auto` prefers Chrome, then Edge, then Brave — the order reflects how likely each
 * is to be the browser a user actually chose rather than one Windows shipped.
 * @param channel - the configured choice; `bundled` never resolves to a system browser.
 * @param env - environment lookup, injected so tests need no real machine.
 * @returns the detected browser, or undefined when the choice is unavailable.
 */
export declare function detectBrowser(channel: BrowserChannel, env?: NodeJS.ProcessEnv): DetectedBrowser | undefined;
/** A system browser driven over CDP, presented as a browser view host. */
export declare class SystemBrowserViewHost implements ElectronBrowserViewHost {
    private readonly child;
    private readonly client;
    readonly kind: DetectedBrowser['kind'];
    private readonly ephemeralDir?;
    private readonly views;
    private disposed;
    /**
     * @param child - the launched browser process.
     * @param client - the CDP connection to it.
     * @param kind - which product this is (for diagnostics).
     * @param ephemeralDir - a throwaway profile to remove on release, when the user
     *   has turned persistence off and no login state should outlive the session.
     */
    private constructor();
    /**
     * @param browser - the detected installation to launch.
     * @param profileDir - a plugin-owned directory; the user's own profile is never touched.
     * @param extraArgs - additional Chromium switches.
     * @param ephemeralDir - a directory to delete when the browser is released, used
     *   when persistence is switched off so no login state outlives the session.
     * @returns the host, or undefined when the browser refuses to come up.
     */
    static launch(browser: DetectedBrowser, profileDir: string, extraArgs?: readonly string[], ephemeralDir?: string): Promise<SystemBrowserViewHost | undefined>;
    /** Whether this host can back views: the CDP connection is live. */
    available(): boolean;
    createView(): ElectronViewHandle;
    destroyView(handle: ElectronViewHandle): void;
    /** Nothing to show: the browser owns its own windows. */
    showView(): void;
    /** Same as {@link showView}. */
    presentView(): Promise<void>;
    /** The browser owns window grouping. */
    groupView(): void;
    /**
     * Bring the browser's window forward.
     *
     * The browser is a separate application, so there is no view to raise; focusing
     * the process is the closest honest equivalent, and failing to do so (a minimized
     * window, a locked session) is never worth an error.
     */
    focus(): Promise<void>;
    /** The browser reports its own window lifecycle. */
    onUserAction(): void;
    /** The browser reports its own window lifecycle. */
    onViewClosed(): void;
    /** Close the browser we launched. The user's own windows are a different process. */
    dispose(): void;
    /** The flattened session for a view, creating its page on first use. */
    private ensureSession;
    /** sessionId -> targetId, so a destroyed view can close the right page. */
    private readonly sessions;
}
