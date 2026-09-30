/**
 * Electron browser provider plugin entry: registers the Electron-backed
 * `BrowserProvider` with `ctx.browser`. The provider needs a view host (real
 * Electron `WebContentsView` objects). When a desktop shell supplies
 * `ctx.electronViewHost`, that host is used (embedded, human-machine shared
 * view). Otherwise the plugin self-hosts: it spawns its own Electron child
 * (`host-main.js`) and drives it over a local TCP JSON-RPC socket, so
 * installing the plugin is enough for `browser_*` tools to work on any
 * surface.
 * @module dsh-browser/browser-electron
 */
import z from '@deepseek-ai/schemastery';
import { ElectronBrowserProvider } from './provider.js';
import { defaultHostMainPath, RemoteElectronViewHost } from './remote-host.js';
import { SettingsStore } from './settings-store.js';
export { ELECTRON_BROWSER_PROVIDER_ID, ElectronBrowserProvider, } from './provider.js';
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-electron';
/** The browser seam this provider registers into. */
export const inject = ['browser'];
export const Config = z.object({
    // Absent on surfaces without a desktop shell; the plugin self-hosts then.
    viewHost: z.any(),
    httpOnly: z.boolean().default(true),
    downloadDir: z.string(),
    snapshotMaxElements: z.number(),
    contentMaxChars: z.number(),
});
/** Register the Electron browser provider with `ctx.browser`. */
export function apply(ctx, config) {
    // External host (desktop shell) wins; otherwise self-host. The self-hosted
    // child is disposed with the fiber, mirroring the shell's lifetime.
    const host = config.viewHost ?? new RemoteElectronViewHost(defaultHostMainPath());
    // One settings document per plugin instance: the settings panel writes it, the
    // provider reads it live, and both ends agree on the same file.
    const settings = new SettingsStore();
    // Own the disposer on THIS plugin's fiber: registerBrowserProvider's effect
    // is bound to the seam's own fiber (the browser row), so a reload of this
    // row would otherwise collide with the still-registered provider
    // (BROWSER_DUPLICATE_PROVIDER) or leave a stale provider behind.
    const unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(host, {
        httpOnly: config.httpOnly,
        downloadDir: config.downloadDir,
        snapshotMaxElements: config.snapshotMaxElements,
        contentMaxChars: config.contentMaxChars,
        settings: () => settings.get(),
    }));
    ctx.effect(() => () => {
        unregister();
        if (config.viewHost === undefined && host instanceof RemoteElectronViewHost) {
            host.dispose();
        }
    });
    installSettingsRoute(ctx, settings);
}
/** Route the settings panel reads and writes. */
const SETTINGS_ROUTE = '/dsh-builtin-browser/settings';
/**
 * Expose the settings document over the host's web server, which is how the
 * settings panel reads and writes it. A host without that service (headless /
 * CLI surfaces) simply skips this: the panel is then unreachable and the file
 * stays hand-editable — never a plugin-startup failure.
 * @param ctx - the plugin context.
 * @param settings - the settings document to expose.
 */
function installSettingsRoute(ctx, settings) {
    const inject = ctx.inject;
    if (typeof inject !== 'function')
        return;
    try {
        inject(['webServer'], (host) => {
            host.effect(() => host.webServer.register({
                kind: 'exact',
                path: SETTINGS_ROUTE,
                handler: (request, response) => handleSettingsRequest(request, response, settings),
            }, 'dsh-builtin-browser: settings'));
        });
    }
    catch {
        // No web server on this surface: the settings file remains the interface.
    }
}
/**
 * Same-origin guard. Settings are machine-local configuration, so a page loaded
 * elsewhere must not be able to read or rewrite them.
 * @param request - the incoming request.
 * @returns whether the request may touch the settings document.
 */
function sameOrigin(request) {
    const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (site === 'cross-site')
        return false;
    const origin = String(request.headers.origin ?? '').trim();
    if (origin === 'null')
        return false;
    if (origin === '')
        return true;
    try {
        return new URL(origin).host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase();
    }
    catch {
        return false;
    }
}
/**
 * One settings round-trip: `GET` reads the document, `PUT`/`POST` merges a
 * partial patch into it.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param settings - the settings document.
 */
async function handleSettingsRequest(request, response, settings) {
    const json = (status, body) => {
        response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
        });
        response.end(JSON.stringify(body));
    };
    if (!sameOrigin(request)) {
        json(403, { ok: false, error: 'cross-origin request refused' });
        return;
    }
    const method = request.method ?? 'GET';
    if (method === 'GET') {
        json(200, { ok: true, settings: settings.get(), path: settings.path() });
        return;
    }
    if (method !== 'PUT' && method !== 'POST') {
        response.writeHead(405, { allow: 'GET, PUT' });
        response.end();
        return;
    }
    try {
        const body = await readBody(request);
        const patch = body.trim() === '' ? {} : JSON.parse(body);
        json(200, { ok: true, settings: settings.update(patch) });
    }
    catch (error) {
        json(400, { ok: false, error: `invalid settings patch: ${String(error)}` });
    }
}
/**
 * Read a request body with a hard cap (the settings patch is tiny, and an
 * unbounded read would let any same-origin caller exhaust memory).
 * @param request - the incoming request.
 * @param limit - maximum accepted characters.
 * @returns the body text.
 */
function readBody(request, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let text = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
            text += String(chunk);
            if (text.length > limit) {
                request.destroy();
                reject(new Error('settings patch too large'));
            }
        });
        request.on('end', () => resolve(text));
        request.on('error', reject);
    });
}
