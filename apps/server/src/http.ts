import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ATTACHMENT_MAX_BYTES, PairRequest, PairingCodeRequest, SimulateRequest, InboxSource, Priority, isArtifactId } from "@homebase/protocol";
import { z } from "zod";
import type { Directory, AuthedDevice } from "./directory";
import type { WorkspaceHub } from "./hub/WorkspaceHub";
import { simulate } from "./ingest/simulator";
import { attachmentRow, saveAttachment } from "./attachments";
import type { WebDir } from "./web";

export const VERSION = "0.1.0";

const IngestInbox = z.object({
  source: InboxSource, externalId: z.string().min(1).max(200), title: z.string().min(1).max(500), snippet: z.string().max(2000).optional(),
  body: z.string().max(50000).optional(), sender: z.string().max(300).optional(), clientLabel: z.string().max(200).optional(),
  externalUrl: z.string().max(2000).optional(), receivedAt: z.number().int().optional(), priority: Priority.optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const bearer = (h: string | undefined) => (h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined);

/** Image types a connector may store. Anything else is refused, so the hub never serves a file a browser would run. */
export const ARTIFACT_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

export function createHttpApp(hub: WorkspaceHub, directory: Directory, opts: { artifactsDir?: string; attachmentsDir?: string; web?: WebDir | null } = {}) {
  const app = new Hono<{ Variables: { device: AuthedDevice } }>();
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "X-File-Name"], allowMethods: ["GET", "POST", "PUT", "OPTIONS"] }));

  const deviceAuth = async (c: any, next: any) => {
    const d = directory.authenticate(bearer(c.req.header("Authorization")));
    if (!d || d.kind !== "device") return c.json({ error: { code: "unauthorized", message: "A valid device token is required" } }, 401);
    c.set("device", d);
    await next();
  };
  const connectorAuth = async (c: any, next: any) => {
    const d = directory.authenticate(bearer(c.req.header("Authorization")));
    if (!d || d.kind !== "connector") return c.json({ error: { code: "unauthorized", message: "A valid connector token is required" } }, 401);
    c.set("device", d);
    await next();
  };
  /** A paired device or a connector: everyone the owner paired. Used where both read the same bytes. */
  const pairedAuth = async (c: any, next: any) => {
    const d = directory.authenticate(bearer(c.req.header("Authorization")));
    if (!d) return c.json({ error: { code: "unauthorized", message: "A valid device or connector token is required" } }, 401);
    c.set("device", d);
    await next();
  };
  const integrationAuth = async (c: any, next: any) => {
    if (!directory.authenticateIntegration(bearer(c.req.header("Authorization")))) {
      return c.json({ error: { code: "unauthorized", message: "A valid integration token is required" } }, 401);
    }
    await next();
  };
  const body = async (c: any) => {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  };
  const bad = (c: any, message: string) => c.json({ error: { code: "invalid_request", message } }, 400);

  // The web client (web.ts) when this hub has the export; otherwise the hub's own JSON, as before.
  const webResponse = (c: any) => opts.web?.respond(c.req.method, new URL(c.req.url).pathname, { ifNoneMatch: c.req.header("If-None-Match") }) ?? null;
  app.get("/", (c) => webResponse(c) ?? c.json({ ok: true, service: "homebase-hub", version: VERSION }));
  app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION, time: hub.now() }));

  app.post("/v1/pair", async (c) => {
    const parsed = PairRequest.safeParse(await body(c));
    if (!parsed.success) return bad(c, "Expected { code, kind, name, platform }");
    const r = directory.pair(parsed.data);
    if (!r.ok) return c.json({ error: { code: r.code, message: r.message } }, 400);
    if (parsed.data.kind === "device") {
      // Make the new device visible to already-connected clients.
      hub.commit(r.deviceId, null, (tx) => {
        const d = tx.get("devices", r.deviceId);
        if (d) tx.upsert("devices", d);
      });
    }
    hub.log(`paired ${parsed.data.kind}: ${parsed.data.name} (${parsed.data.platform})`);
    return c.json({ token: r.token, deviceId: r.deviceId, workspaceId: r.workspaceId });
  });

  app.post("/v1/pairing-codes", deviceAuth, async (c) => {
    const parsed = PairingCodeRequest.safeParse(await body(c));
    if (!parsed.success) return bad(c, "Expected { kind }");
    const device = c.get("device");
    if (!device.canApprove) return c.json({ error: { code: "forbidden", message: "This device cannot create pairing codes" } }, 403);
    return c.json(directory.createPairingCode(parsed.data.kind, device.id));
  });

  app.get("/v1/runs/:runId/events", deviceAuth, (c) => {
    const after = Number(c.req.query("after") ?? -1);
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 500)));
    const rows = hub.store.all<{ run_id: string; idx: number; at: number; kind: string; data: string }>(
      "SELECT * FROM run_events WHERE run_id = ? AND idx > ? ORDER BY idx LIMIT ?", c.req.param("runId"), after, limit,
    );
    return c.json({
      events: rows.map((r) => ({ runId: r.run_id, idx: Number(r.idx), at: Number(r.at), kind: r.kind, data: JSON.parse(r.data) })),
    });
  });

  app.get("/v1/audit", deviceAuth, (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 50)));
    const rows = hub.store.all<any>("SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?", limit);
    return c.json({
      entries: rows.map((r) => ({
        id: r.id, at: Number(r.at), actorId: r.actor_id, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id,
        detail: r.detail ? JSON.parse(r.detail) : null,
      })),
    });
  });

  // Images made in sessions (docs/MULTI-PROVIDER-PLAN.md). A connector stores the bytes once, under an id it made;
  // paired devices read them. Tokens travel in the Authorization header, as everywhere else.
  app.put("/v1/artifacts/:id", connectorAuth, async (c) => {
    const dir = opts.artifactsDir;
    if (!dir) return c.json({ error: { code: "unavailable", message: "This hub has no artifact storage" } }, 503);
    const id = c.req.param("id");
    if (!isArtifactId(id)) return bad(c, "Not an artifact id");
    const mime = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ARTIFACT_MIME.has(mime)) return bad(c, "Only PNG, JPEG, WebP and SVG images are stored");
    if (Number(c.req.header("Content-Length") ?? 0) > ARTIFACT_MAX_BYTES) return c.json({ error: { code: "too_large", message: "The image is larger than 16 MB" } }, 413);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length) return bad(c, "Empty body");
    if (buf.length > ARTIFACT_MAX_BYTES) return c.json({ error: { code: "too_large", message: "The image is larger than 16 MB" } }, 413);
    const sha = createHash("sha256").update(buf).digest("hex");
    const known = hub.store.get<{ sha256: string }>("SELECT sha256 FROM artifacts WHERE id = ?", id);
    // An artifact is written once. The same bytes again (a retry) is fine; different bytes under a known id is refused.
    if (known) return known.sha256 === sha ? c.json({ ok: true, id, bytes: buf.length, sha256: sha }) : c.json({ error: { code: "conflict", message: "That artifact already exists" } }, 409);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id), buf);
    hub.store.run("INSERT INTO artifacts (id, mime, bytes, sha256, connector_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, mime, buf.length, sha, c.get("device").id, hub.now());
    return c.json({ ok: true, id, bytes: buf.length, sha256: sha });
  });

  app.get("/v1/artifacts/:id", deviceAuth, (c) => {
    const id = c.req.param("id");
    const row = opts.artifactsDir && isArtifactId(id) ? hub.store.get<{ mime: string }>("SELECT mime FROM artifacts WHERE id = ?", id) : undefined;
    const file = row ? join(opts.artifactsDir!, id) : null;
    if (!row || !file || !existsSync(file)) return c.json({ error: { code: "not_found", message: "No such image" } }, 404);
    return new Response(new Uint8Array(readFileSync(file)), {
      headers: {
        "Content-Type": row.mime, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
        // An SVG opened on its own must stay a picture: no scripts, no requests.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });

  // Pictures the owner attaches to a message (packages/protocol/src/attachments.ts). A device uploads each one once,
  // under an id it made, then sends the message with the ids. Devices and the connector read them back with their own
  // token in the Authorization header. There is no public address: every read is authenticated.
  app.put("/v1/attachments/:id", deviceAuth, async (c) => {
    const dir = opts.attachmentsDir;
    if (!dir) return c.json({ error: { code: "unavailable", message: "This hub has no attachment storage" } }, 503);
    if (Number(c.req.header("Content-Length") ?? 0) > ATTACHMENT_MAX_BYTES) {
      return c.json({ error: { code: "too_large", message: `The image is larger than ${(ATTACHMENT_MAX_BYTES / 1_000_000).toFixed(2)} MB` } }, 413);
    }
    const r = saveAttachment(hub.store, dir, {
      id: c.req.param("id"), body: new Uint8Array(await c.req.arrayBuffer()), deviceId: c.get("device").id, name: c.req.header("X-File-Name") ?? null, now: hub.now(),
    });
    if (!r.ok) return c.json({ error: { code: r.code, message: r.message } }, r.status);
    return c.json({ ok: true, attachment: r.attachment });
  });

  app.get("/v1/attachments/:id", pairedAuth, (c) => {
    const id = c.req.param("id");
    const row = opts.attachmentsDir ? attachmentRow(hub.store, id) : undefined;
    const file = row ? join(opts.attachmentsDir!, id) : null;
    if (!row || !file || !existsSync(file)) return c.json({ error: { code: "not_found", message: "No such image" } }, 404);
    return new Response(new Uint8Array(readFileSync(file)), {
      headers: {
        "Content-Type": row.mime, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });

  app.post("/v1/ingest/inbox", integrationAuth, async (c) => {
    const parsed = IngestInbox.safeParse(await body(c));
    if (!parsed.success) return bad(c, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const item = hub.ingest(parsed.data);
    return c.json({ item });
  });

  app.post("/v1/ingest/agent-event", integrationAuth, (c) =>
    c.json({ error: { code: "not_implemented", message: "Agent events from non-connector bots arrive at MVP" } }, 501));

  app.post("/v1/dev/simulate", deviceAuth, async (c) => {
    if (!hub.devMode) return c.json({ error: { code: "not_found", message: "Dev mode is off" } }, 404);
    const parsed = SimulateRequest.safeParse(await body(c));
    if (!parsed.success) return bad(c, "Expected { kind: gmail | clickup | monitor | resend | calendar }");
    const item = hub.ingest(simulate(parsed.data.kind, hub.now()), c.get("device").id);
    return c.json({ item });
  });

  app.post("/v1/dev/notify-test", deviceAuth, (c) => {
    if (!hub.devMode) return c.json({ error: { code: "not_found", message: "Dev mode is off" } }, 404);
    hub.commit(c.get("device").id, null, (tx) =>
      tx.notify({
        priority: "P1", channel: "p1_today", title: "Test notification", body: "If you can read this, HomeBase notifications work on this device.",
        link: "/settings", actions: ["open"], collapseKey: "test",
      }));
    return c.json({ ok: true });
  });

  // Anything else: a file of the web client or one of its routes (never under /v1), else the API's 404.
  app.notFound((c) => webResponse(c) ?? c.json({ error: { code: "not_found", message: "No such route" } }, 404));
  return app;
}
