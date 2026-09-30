/**
 * Persistent browsing history: which pages the shared browser actually visited,
 * kept independently from any session's operation log (`browser_history`) and
 * from the browser process's lifetime.
 *
 * It lives beside the browser profile (`$DSH_HOME/dsh-builtin-browser-host/
 * history.jsonl`), so it follows the same persistence rules as the login state:
 * closing the interface releases the process, never the record.
 *
 * Format: one JSON object per line, append-only. Appending stays cheap for a
 * long session, and a half-written tail (crash, power loss) is dropped on read
 * instead of poisoning the whole file.
 * @module dsh-browser/browser-electron/history-store
 */
import type { VisitedPage } from '../browser/types.js';
export type { VisitedPage };
/** Retention limits; whichever is hit first starts trimming. */
export interface HistoryLimits {
    /** Maximum retained entries. Default 5000. */
    readonly maxEntries?: number;
    /** Maximum age in days. Default 90. */
    readonly maxAgeDays?: number;
}
/**
 * Absolute path of the browsing-history file, beside the browser profile so the
 * record shares the login state's persistence rules.
 * @returns the history file path.
 */
export declare function visitedHistoryPath(): string;
/**
 * Append-only browsing history with bounded retention. Every method tolerates a
 * missing or damaged file: recording a visit must never fail a navigation, and
 * a corrupted line must never hide the rest of the history.
 */
export declare class HistoryStore {
    private readonly file;
    private readonly maxEntries;
    private readonly maxAgeMs;
    /**
     * @param file - absolute path of the JSONL history file.
     * @param limits - retention overrides (entry count and age).
     */
    constructor(file?: string, limits?: HistoryLimits);
    /** Whether the history file exists yet (diagnostics and tests). */
    exists(): boolean;
    /**
     * Record one visit. Failures are swallowed by design: history is a
     * convenience, and losing an entry must never break the tool call that
     * produced it.
     * @param page - the visited page.
     */
    append(page: VisitedPage): void;
    /**
     * Read visits, newest first. Unparseable lines are skipped; entries older
     * than the age limit are filtered out but left on disk until the next prune.
     * @param options - optional result cap and domain filter.
     * @returns the matching visits, newest first.
     */
    list(options?: {
        readonly limit?: number;
        readonly domain?: string;
    }): VisitedPage[];
    /**
     * Enforce retention: drop entries past the age limit, then the oldest beyond
     * the count cap. Cheap no-op until the file grows past the cap, so callers can
     * run it after every append.
     */
    prune(): void;
    /** Parse the whole file, skipping blank and damaged lines. */
    private readAll;
}
