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
/** Element id of the overlay root, stable so repeat calls update one node. */
const CURSOR_ID = '__dsh_agent_cursor__';
/**
 * The in-page expression that materializes or moves the overlay. Idempotent: the
 * first call creates the nodes, later calls only move them (and pulse).
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @param action - whether to pulse a click ripple at the point.
 * @returns a self-contained expression that evaluates to `true`.
 */
export function cursorScript(x, y, action) {
    return `(() => {
  const id = ${JSON.stringify(CURSOR_ID)}
  let root = document.getElementById(id)
  if (!root) {
    root = document.createElement('div')
    root.id = id
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transition:transform 120ms ease-out;will-change:transform'
    const svg = '<svg width="22" height="22" viewBox="0 0 22 22" style="position:absolute;left:-2px;top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">'
      + '<path d="M4 2 L4 18 L8.4 13.8 L11.2 19.6 L13.8 18.4 L11 12.8 L17 12.6 Z" fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    const ripple = '<span style="position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(64,160,255,.9);opacity:0"></span>'
    root.innerHTML = svg + ripple
    ;(document.body || document.documentElement).appendChild(root)
  }
  root.style.transform = 'translate(${x}px, ${y}px)'
  ${action === 'click' ? `const ripple = root.lastElementChild
  if (ripple && typeof ripple.animate === 'function') {
    ripple.animate(
      [{ transform: 'scale(.25)', opacity: 0.95 }, { transform: 'scale(1.6)', opacity: 0 }],
      { duration: 550, easing: 'ease-out' },
    )
  }` : ''}
  return true
})()`;
}
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
 */
export function paintCursor(handle, x, y, action, evaluate) {
    if (!Number.isFinite(x) || !Number.isFinite(y))
        return;
    void evaluate(handle, cursorScript(Math.round(x), Math.round(y), action)).catch(() => { });
}
