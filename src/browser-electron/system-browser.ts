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

import { readFileSync, rmSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js'

/** Which browser the user asked for. */
export type BrowserChannel = 'bundled' | 'chrome' | 'edge' | 'auto'

/** A resolved browser installation. */
export interface DetectedBrowser {
  /** Which product this is. */
  readonly kind: 'chrome' | 'edge' | 'brave'
  /** Absolute path to the executable. */
  readonly path: string
}

/**
 * Where each Chromium product installs on Windows, plus the registry paths that
 * survive a non-default install location. Only paths that exist are returned, so a
 * caller can tell "not installed" from "installed elsewhere".
 */
const WINDOWS_LOCATIONS: Record<DetectedBrowser['kind'], string[]> = {
  chrome: [
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
  ],
  edge: [
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
  ],
  brave: [
    String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
    String.raw`C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe`,
  ],
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
export function detectBrowser(channel: BrowserChannel, env: NodeJS.ProcessEnv = process.env): DetectedBrowser | undefined {
  if (channel === 'bundled') return undefined
  const order: DetectedBrowser['kind'][] = channel === 'auto' ? ['chrome', 'edge', 'brave'] : [channel as DetectedBrowser['kind']]
  for (const kind of order) {
    const fromEnv = (kind === 'chrome' ? env.DSH_BROWSER_CHROME_PATH : kind === 'edge' ? env.DSH_BROWSER_EDGE_PATH : undefined)
    if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return { kind, path: fromEnv }
    for (const candidate of WINDOWS_LOCATIONS[kind] ?? []) {
      if (existsSync(candidate)) return { kind, path: candidate }
    }
  }
  return undefined
}

/** One CDP connection to a browser-level WebSocket, with flattened sessions. */
class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly ready: Promise<void>

  /**
   * @param url - the browser's `webSocketDebuggerUrl`.
   */
  constructor(private readonly url: string) {
    // Node 22 provides WebSocket globally; no dependency is added for this.
    const socket = new WebSocket(url)
    this.socket = socket
    this.ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('dsh-builtin-browser: could not reach the browser over CDP')))
    })
    socket.addEventListener('message', event => this.onMessage(String((event as MessageEvent).data)))
    socket.addEventListener('close', () => this.fail(new Error('dsh-builtin-browser: the browser closed the CDP connection')))
  }

  private readonly socket: WebSocket

  /** Resolve once the socket is open. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  /**
   * Send one CDP command, optionally on an attached session.
   * @param method - the CDP method.
   * @param params - its parameters.
   * @param sessionId - the flattened session to target, when this is a page command.
   * @returns the CDP result.
   */
  async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    await this.ready
    const id = this.nextId++
    const message = { id, method, ...params !== undefined ? { params } : {}, ...sessionId !== undefined ? { sessionId } : {} }
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify(message))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`dsh-builtin-browser: ${method} timed out`))
      }, 30_000).unref?.()
    })
  }

  /** Close the socket. */
  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
  }

  /** Route one CDP message to its waiter. */
  private onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try { message = JSON.parse(raw) } catch { return }
    if (message.id === undefined) return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`dsh-builtin-browser: CDP error: ${message.error.message ?? 'unknown'}`))
    else entry.resolve(message.result)
  }

  /** Fail everything in flight. */
  private fail(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }
}

/** A system browser driven over CDP, presented as a browser view host. */
export class SystemBrowserViewHost implements ElectronBrowserViewHost {
  private readonly views = new Map<string, string>()
  private disposed = false

  /**
   * @param child - the launched browser process.
   * @param client - the CDP connection to it.
   * @param kind - which product this is (for diagnostics).
   * @param ephemeralDir - a throwaway profile to remove on release, when the user
   *   has turned persistence off and no login state should outlive the session.
   */
  private constructor(
    private readonly child: ChildProcess,
    private readonly client: CdpClient,
    readonly kind: DetectedBrowser['kind'],
    private readonly ephemeralDir?: string,
  ) {}

  /**
   * @param browser - the detected installation to launch.
   * @param profileDir - a plugin-owned directory; the user's own profile is never touched.
   * @param extraArgs - additional Chromium switches.
   * @param ephemeralDir - a directory to delete when the browser is released, used
   *   when persistence is switched off so no login state outlives the session.
   * @returns the host, or undefined when the browser refuses to come up.
   */
  static async launch(browser: DetectedBrowser, profileDir: string, extraArgs: readonly string[] = [], ephemeralDir?: string): Promise<SystemBrowserViewHost | undefined> {
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      // Behave like a fresh, unattended browser: no first-run UI, no default-browser
      // prompt, no restore bubble, and no "Chrome is being controlled" infobar.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      ...extraArgs,
      'about:blank',
    ]
    const child = spawn(browser.path, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false })
    const portFile = join(profileDir, 'DevToolsActivePort')
    const deadline = Date.now() + 30_000
    for (;;) {
      if (Date.now() > deadline) { child.kill(); return undefined }
      if (child.exitCode !== null) return undefined
      if (existsSync(portFile)) {
        try {
          const port = readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? ''
          if (port !== '') {
            const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl?: string }
            if (typeof version.webSocketDebuggerUrl === 'string') {
              const client = new CdpClient(version.webSocketDebuggerUrl)
              await client.whenReady()
              return new SystemBrowserViewHost(child, client, browser.kind, ephemeralDir)
            }
          }
        } catch {
          // The file can exist a moment before the port answers; poll again.
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  /** Whether this host can back views: the CDP connection is live. */
  available(): boolean {
    return !this.disposed
  }

  createView(): ElectronViewHandle {
    const viewId = randomUUID()
    return {
      id: viewId,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        const session = this.views.get(viewId) ?? await this.ensureSession(viewId)
        const result = await this.client.send(method, params, session)
        return (result ?? {}) as Record<string, unknown>
      },
    }
  }

  destroyView(handle: ElectronViewHandle): void {
    const session = this.views.get(handle.id)
    this.views.delete(handle.id)
    if (session === undefined) return
    // A session id is not a target id: closing the page needs the target the session
    // was attached to, which is why they are tracked separately.
    const targetId = this.sessions.get(session)
    this.sessions.delete(session)
    if (targetId !== undefined) {
      // Best-effort: a page that is already gone is not an error.
      void this.client.send('Target.closeTarget', { targetId }).catch(() => undefined)
    }
  }

  /** Nothing to show: the browser owns its own windows. */
  showView(): void {}

  /** Same as {@link showView}. */
  async presentView(): Promise<void> {}

  /** The browser owns window grouping. */
  groupView(): void {}

  /**
   * Bring the browser's window forward.
   *
   * The browser is a separate application, so there is no view to raise; focusing
   * the process is the closest honest equivalent, and failing to do so (a minimized
   * window, a locked session) is never worth an error.
   */
  async focus(): Promise<void> {
    try { this.child.kill('SIGCONT') } catch { /* not supported on Windows; harmless */ }
  }

  /** The browser reports its own window lifecycle. */
  onUserAction(): void {}

  /** The browser reports its own window lifecycle. */
  onViewClosed(): void {}

  /** Close the browser we launched. The user's own windows are a different process. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.views.clear()
    this.sessions.clear()
    this.client.close()
    try { this.child.kill() } catch { /* already gone */ }
    const ephemeral = this.ephemeralDir
    if (ephemeral !== undefined) {
      // The browser flushes its profile while shutting down, so deleting later avoids
      // racing it. Leftovers are only a stray temp directory, never a live credential.
      setTimeout(() => { try { rmSync(ephemeral, { recursive: true, force: true }) } catch { /* best effort */ } }, 3_000).unref?.()
    }
  }

  /** The flattened session for a view, creating its page on first use. */
  private async ensureSession(viewId: string): Promise<string> {
    const existing = this.views.get(viewId)
    if (existing !== undefined) return existing
    const created = await this.client.send('Target.createTarget', { url: 'about:blank' }) as { targetId?: string }
    const targetId = created?.targetId
    if (typeof targetId !== 'string') throw new Error('dsh-builtin-browser: the browser did not create a page')
    const attached = await this.client.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: string }
    const sessionId = attached?.sessionId
    if (typeof sessionId !== 'string') throw new Error('dsh-builtin-browser: the browser did not attach to the new page')
    // The session id is what page commands ride; the target id is what closes it.
    this.sessions.set(sessionId, targetId)
    this.views.set(viewId, sessionId)
    return sessionId
  }

  /** sessionId -> targetId, so a destroyed view can close the right page. */
  private readonly sessions = new Map<string, string>()
}
