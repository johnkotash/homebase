/**
 * Temporary diagnostics for the phone's browser take-over (docs/STATUS.md, 2026-11-23 round 9). When on,
 * the view writes where each finger landed, what was sent and how the pictures arrive to the console, which
 * on Android is the app's own logcat (tag ReactNativeJS, prefix "[hb-browser]"). Never what was typed.
 * Off in shipped builds.
 */
export const BROWSER_DEBUG = false;

export function bdbg(...parts: unknown[]): void {
  if (!BROWSER_DEBUG) return;
  // eslint-disable-next-line no-console
  console.log("[hb-browser]", ...parts.map((p) => (typeof p === "object" && p !== null ? JSON.stringify(p) : p)));
}
