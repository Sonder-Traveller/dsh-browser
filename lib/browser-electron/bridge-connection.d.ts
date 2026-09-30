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
/** Where the shell publishes its bridge endpoint. */
export interface BridgeEndpoint {
    readonly port: number;
    readonly token: string;
    readonly pid: number;
    readonly updatedAt?: string;
}
/**
 * A reusable connection to the bridge.
 *
 * Requests are serialised by construction: one socket, one in-flight request at a
 * time, answered in order. A broken socket is discarded so the next call dials
 * again — a dead connection must never become a dead plugin.
 */
export declare class BridgeConnection {
    private readonly endpoint;
    private socket;
    private buffer;
    private readonly queue;
    /**
     * @param endpoint - the shell's published bridge endpoint.
     */
    constructor(endpoint: BridgeEndpoint);
    /**
     * Send one request, reusing the socket if it is still healthy.
     * @param request - the request body (the token is added here).
     * @param timeoutMs - how long to wait for the answer before dropping the socket.
     * @returns the bridge's answer.
     */
    call(request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
    /** Close the socket and fail anything still waiting on it. */
    close(): void;
    /** The live socket, connecting and authenticating it on first use. */
    private ensureSocket;
    /** Resolve queued requests in order as answers arrive. */
    private onData;
    /** Tear the socket down, failing pending work. */
    private reset;
}
