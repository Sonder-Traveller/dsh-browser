/**
 * Transport for the desktop shell's browser bridge: one long-lived connection to a
 * loopback TCP service.
 *
 * WHY THIS IS ITS OWN MODULE
 * The bridge used to be reached with a fresh connection per request, which measured
 * at ~25ms per call (TCP handshake + token exchange) against ~0.2ms when the socket
 * is reused. A single browser action issues several CDP commands, so that cost was
 * multiplied on every tool call — the difference between a snappy agent and a
 * visibly sluggish one. Reuse is therefore a property of the transport, and keeping
 * it here means the view host above does not have to think about sockets at all.
 *
 * PROTOCOL
 * The first line on a connection carries the token; the service marks the socket
 * authenticated and ignores that line as a command. Requests and answers are then
 * newline-delimited JSON, one answer per request, in order.
 *
 * @module dsh-browser/browser-electron/bridge-connection
 */

import { connect, type Socket } from 'node:net'

/** Where the shell publishes its bridge endpoint. */
export interface BridgeEndpoint {
  readonly port: number
  readonly token: string
  readonly pid: number
  readonly updatedAt?: string
}

/** One queued request, waiting for its answer. */
interface PendingCall {
  readonly resolve: (answer: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}

/**
 * A reusable connection to the bridge.
 *
 * Requests are serialised by construction: one socket, one in-flight request at a
 * time, answered in order. A broken socket is discarded so the next call dials
 * again — a dead connection must never become a dead plugin.
 */
export class BridgeConnection {
  private socket: Socket | undefined
  private buffer = ''
  private readonly queue: PendingCall[] = []

  /**
   * @param endpoint - the shell's published bridge endpoint.
   */
  constructor(private readonly endpoint: BridgeEndpoint) {}

  /**
   * Send one request, reusing the socket if it is still healthy.
   * @param request - the request body (the token is added here).
   * @param timeoutMs - how long to wait for the answer before dropping the socket.
   * @returns the bridge's answer.
   */
  async call(request: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const socket = this.ensureSocket()
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.queue.findIndex(entry => entry.resolve === resolve)
        if (index !== -1) this.queue.splice(index, 1)
        const error = new Error(`dsh-builtin-browser: bridge timed out after ${timeoutMs}ms`)
        this.reset(error)
        reject(error)
      }, timeoutMs)
      this.queue.push({
        resolve: answer => { clearTimeout(timer); resolve(answer) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try {
        socket.write(JSON.stringify({ token: this.endpoint.token, ...request }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.queue.pop()
        const failure = error instanceof Error ? error : new Error(String(error))
        this.reset(failure)
        reject(failure)
      }
    })
  }

  /** Close the socket and fail anything still waiting on it. */
  close(): void {
    this.reset(new Error('dsh-builtin-browser: bridge closed'))
  }

  /** The live socket, connecting and authenticating it on first use. */
  private ensureSocket(): Socket {
    if (this.socket !== undefined) return this.socket
    const socket = connect({ host: '127.0.0.1', port: this.endpoint.port })
    socket.setEncoding('utf8')
    socket.on('data', chunk => this.onData(String(chunk)))
    socket.on('error', error => this.reset(error))
    socket.on('close', () => this.reset(new Error('dsh-builtin-browser: bridge connection closed')))
    this.buffer = ''
    this.socket = socket
    socket.write(JSON.stringify({ token: this.endpoint.token }) + '\n')
    return socket
  }

  /** Resolve queued requests in order as answers arrive. */
  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line === '') continue
      const entry = this.queue.shift()
      if (entry === undefined) continue
      try {
        const answer = JSON.parse(line) as Record<string, unknown>
        // A rejected token means the shell restarted with a new one, so this socket
        // can never succeed again: answer (the caller needs the error) and drop it,
        // so the next call dials afresh instead of retrying a doomed credential.
        if (answer.ok === false && answer.error === 'bad token') {
          entry.resolve(answer)
          this.reset(new Error('dsh-builtin-browser: the bridge rejected our token'))
          continue
        }
        entry.resolve(answer)
      } catch (error) {
        entry.reject(new Error(`dsh-builtin-browser: malformed bridge answer (${String(error)})`))
      }
    }
  }

  /** Tear the socket down, failing pending work. */
  private reset(error: Error): void {
    if (this.socket !== undefined) {
      const socket = this.socket
      this.socket = undefined
      socket.removeAllListeners()
      socket.destroy()
    }
    this.buffer = ''
    const pending = this.queue.splice(0, this.queue.length)
    for (const entry of pending) entry.reject(error)
  }
}
