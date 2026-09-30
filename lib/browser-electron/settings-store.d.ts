/**
 * Plugin-owned settings document — the switches the browser settings panel
 * exposes, stored next to the browsing history so both follow the same rules:
 * they survive the browser process and DSH restarts.
 *
 * Every field is optional on disk and falls back to a default, so a hand-edited
 * or older file never breaks startup; an unreadable file is treated as "all
 * defaults" rather than an error.
 * @module dsh-browser/browser-electron/settings-store
 */
/** Vision/operation strategy the provider prefers when the model can see. */
export type VisionStrategy = 'auto' | 'nonVisual';
/** The full settings document, with every field resolved. */
export interface BrowserSettings {
    /** Persistent browsing history (visited pages). */
    readonly history: {
        readonly enabled: boolean;
        readonly maxEntries: number;
        readonly maxAgeDays: number;
    };
    /** Login-state retention: cookies and the browser profile. */
    readonly cookies: {
        readonly persist: boolean;
    };
    /** Presentation behaviour. */
    readonly ui: {
        /** Auto-expand the side panel once per task, then leave the user alone. */
        readonly autoExpandOnce: boolean;
        /** Release the browser when its session ends, instead of waiting for a close. */
        readonly closeWithSession: boolean;
        /** Show the synthetic cursor/click feedback while the agent operates. */
        readonly virtualCursor: boolean;
    };
    /** Visual vs non-visual operation strategy. */
    readonly vision: {
        readonly strategy: VisionStrategy;
    };
    /** Whether the agent may read cookies / export login state. */
    readonly credentials: {
        readonly allowRead: boolean;
    };
}
/** Defaults for every switch: the documented out-of-the-box behaviour. */
export declare const DEFAULT_SETTINGS: BrowserSettings;
/**
 * Absolute path of the settings file, beside the browser profile and the
 * browsing history.
 * @returns the settings file path.
 */
export declare function settingsPath(): string;
/**
 * Resolve a raw settings document (already parsed, shape unknown) into the full
 * document, field by field. Unknown keys are dropped: the file is not a place to
 * smuggle configuration.
 * @param raw - the parsed file contents.
 * @returns the resolved settings.
 */
export declare function resolveSettings(raw: unknown): BrowserSettings;
/**
 * File-backed settings with an in-memory snapshot. Reads re-stat the file so an
 * edit from another process (or the settings panel writing through a second
 * code path) is picked up without a restart; writes are atomic enough for a
 * single-writer plugin and never throw at the caller.
 */
export declare class SettingsStore {
    private readonly file;
    private cached;
    /** Last observed mtime, used to invalidate the cache on external edits. */
    private cachedMtimeMs;
    /**
     * @param file - settings file path (defaults beside the browser profile).
     */
    constructor(file?: string);
    /** Path this store reads and writes. */
    path(): string;
    /**
     * Current settings, re-read when the file changed on disk.
     * @returns the resolved settings document.
     */
    get(): BrowserSettings;
    /**
     * Merge a partial patch into the stored document and persist it.
     * @param patch - the fields to change (unknown keys are ignored).
     * @returns the settings after the merge.
     */
    update(patch: unknown): BrowserSettings;
}
