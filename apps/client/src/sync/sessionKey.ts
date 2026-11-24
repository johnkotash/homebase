/**
 * Whether the hub connection running now already serves this pairing. The app's root mounts again whenever
 * Android re-creates the activity (opened again from a link or a notification after Back closed it), and the
 * screens inside mount, and subscribe, before the root's own start-up runs. Replacing the connection then
 * dropped what they had subscribed to: the browser screen waited on "Connecting…" for ever. Same hub, same
 * token: keep the connection.
 */
export function sameClientSession(running: { url: string; token: string } | null | undefined, next: { url: string; token: string } | null | undefined): boolean {
  return !!running && !!next && running.url === next.url && running.token === next.token;
}
