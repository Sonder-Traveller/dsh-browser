/**
 * Synthetic pointer feedback for a human watching the tab: an overlay drawn
 * INSIDE the page, never the real system pointer. Its presence is the "the agent
 * has taken over this tab" signal, so it also covers DOM-level operations that
 * move no pointer at all.
 *
 * Implementation notes that matter:
 * - The overlay is `position: fixed` and positioned from viewport coordinates,
 *   which is exactly what the element locator already computes and what
 *   `Input.dispatchMouseEvent` consumes.
 * - All styling is inline and the ripple uses the Web Animations API: a
 *   `<style>` element would be subject to the page's `style-src` CSP, an
 *   injected script is not. Injected page feedback must never be silently
 *   dropped by a strict CSP.
 * - Every call is best-effort: feedback is never allowed to fail an operation.
 * @module dsh-browser/browser-electron/virtual-cursor
 */
/** What the pointer is doing at the reported point. */
export type CursorAction = 'move' | 'click';
/**
 * Whether a paint at this position would change anything on screen.
 * @param handle - the view the overlay belongs to.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @param action - the action being reported.
 * @param force - paint even when unchanged (a click ripple must always fire).
 * @returns true when the overlay should be painted.
 */
export declare function cursorNeedsPaint<TView>(handle: TView, x: number, y: number, action: CursorAction, force?: boolean): boolean;
/**
 * The in-page expression that materializes or moves the overlay. Idempotent: the
 * first call creates the nodes, later calls only move them (and pulse).
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @param action - whether to pulse a click ripple at the point.
 * @param label - optional short description of the operation, shown beside the
 *   pointer. The overlay is the only "the agent has taken over this tab" signal, so
 *   saying *what* it is doing is what turns it from a decoration into an account of
 *   the agent's actions that a human can follow without reading the tool log.
 * @returns a self-contained expression that evaluates to `true`.
 */
export declare function cursorScript(x: number, y: number, action: CursorAction, label?: string): string;
/**
 * Forget the remembered position for a view.
 *
 * Called when the document is replaced: the overlay lived in the old document and
 * went with it, so the cache would otherwise claim the pointer is already where it
 * needs to be and skip every later paint — the pointer would simply never return
 * after a navigation.
 * @param handle - the view whose cache should be dropped.
 */
export declare function forgetCursor<TView>(handle: TView): void;
/**
 * Draw (or move) the pointer overlay on one view's page.
 *
 * Fire-and-forget: a page that is mid-navigation, cross-origin-blocked, or
 * otherwise unable to answer must not turn a successful operation into a
 * failure, and the navigation that just committed may still be replacing the
 * document this call would have painted into.
 * @param handle - the view to paint into.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @param action - whether to pulse a click ripple.
 * @param evaluate - the provider's evaluate bridge (keeps the CDP coupling in one place).
 * @param label - optional short description of the operation, shown beside the pointer.
 */
export declare function paintCursor<TView>(handle: TView, x: number, y: number, action: CursorAction, evaluate: (handle: TView, expression: string) => Promise<unknown>, label?: string, force?: boolean): void;
