import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * The web client, served by the hub itself (2026-11-24), so any browser on the tailnet can open
 * the hub's address (http://<server>:8787/) and pair. The files are the Expo web export (`npm run build:web` on the PC,
 * shipped by scripts/deploy.sh into apps/client/dist, or HOMEBASE_WEB_DIR). The hub never builds it.
 *
 * Rules: GET and HEAD only; nothing under /v1 (the API and the WebSocket) is ever answered from here;
 * a path with a file extension that is not in the export is a 404; any other path is a client-side route
 * and gets index.html (SPA fallback). index.html is never cached; Expo's hashed bundles are cached for a year.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
};

/** Whether a request path belongs to the API (never the web client). */
export function isApiPath(path: string): boolean {
  return path === "/v1" || path.startsWith("/v1/");
}

/** How long a browser may keep a file. */
export function cacheControlFor(rel: string): string {
  if (rel === "/index.html" || extname(rel) === ".html") return "no-cache";
  if (rel.startsWith("/_expo/static/")) return "public, max-age=31536000, immutable"; // content-hashed names
  return "public, max-age=3600";
}

export interface WebDir {
  dir: string;
  /** A response for this request, or null when the web client has nothing to say (the API's 404 applies). */
  respond(method: string, rawPath: string, headers: { ifNoneMatch?: string | null }): Response | null;
}

/** The web export at `dir`, or null when there is none (the hub then answers `/` with its JSON, as before). */
export function openWebDir(dir: string | null | undefined): WebDir | null {
  if (!dir) return null;
  const root = resolve(dir);
  if (!existsSync(join(root, "index.html"))) return null;

  const serve = (file: string, rel: string, method: string, ifNoneMatch: string | null | undefined): Response => {
    const st = statSync(file);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": cacheControlFor(rel),
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    };
    if (extname(file) === ".html") {
      headers["X-Frame-Options"] = "DENY";
      headers["Referrer-Policy"] = "no-referrer";
    }
    if (ifNoneMatch && ifNoneMatch.split(",").map((s) => s.trim()).includes(etag)) return new Response(null, { status: 304, headers });
    headers["Content-Length"] = String(st.size);
    return new Response(method === "HEAD" ? null : new Uint8Array(readFileSync(file)), { status: 200, headers });
  };

  return {
    dir: root,
    respond(method, rawPath, { ifNoneMatch }) {
      if (method !== "GET" && method !== "HEAD") return null;
      let path: string;
      try {
        path = decodeURIComponent(rawPath.split("?")[0] || "/");
      } catch {
        return null;
      }
      if (isApiPath(path) || path.includes("\0")) return null;
      const rel = path === "/" ? "/index.html" : path;
      const file = normalize(join(root, rel));
      // Never anything outside the export.
      if (file !== root && !file.startsWith(root + sep)) return null;
      if (existsSync(file) && statSync(file).isFile()) return serve(file, rel, method, ifNoneMatch);
      if (extname(path)) return null; // a missing file stays a 404, never the app
      return serve(join(root, "index.html"), "/index.html", method, ifNoneMatch);
    },
  };
}
