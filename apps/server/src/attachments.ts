import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENT_MAX_BYTES, isAttachmentId, sniffImage, type MessageAttachment,
} from "@homebase/protocol";
import type { SqlStore } from "./hub/SqlStore";

/**
 * Pictures the owner attaches to messages (packages/protocol/src/attachments.ts). A device uploads the bytes
 * once; the file sits in the hub's data folder under its id, and a row in `attachments` holds what the file
 * really is (checked from its first bytes, never taken from the device's word). Messages carry only the facts.
 */

export interface AttachmentRow {
  id: string; mime: string; bytes: number; sha256: string; width: number | null; height: number | null;
  name: string | null; device_id: string; message_id: string | null; created_at: number;
}

export const toMessageAttachment = (r: AttachmentRow): MessageAttachment => ({
  id: r.id, kind: "image", mime: r.mime as MessageAttachment["mime"], bytes: Number(r.bytes),
  width: r.width == null ? null : Number(r.width), height: r.height == null ? null : Number(r.height), name: r.name ?? null,
});

export type SaveResult =
  | { ok: true; attachment: MessageAttachment; again: boolean }
  | { ok: false; status: 400 | 409 | 413; code: string; message: string };

/** A file name as the app may show it: no folders, no control characters, at most 200 characters. */
export function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    /* keep it as sent */
  }
  s = s.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return s || null;
}

/** Keeps one uploaded picture. The same bytes under the same id again (a retry) is fine; other bytes under a known id are refused. */
export function saveAttachment(store: SqlStore, dir: string, a: { id: string; body: Uint8Array; deviceId: string; name?: string | null; now: number }): SaveResult {
  if (!isAttachmentId(a.id)) return { ok: false, status: 400, code: "invalid_request", message: "Not an attachment id" };
  if (!a.body.length) return { ok: false, status: 400, code: "invalid_request", message: "Empty body" };
  if (a.body.length > ATTACHMENT_MAX_BYTES) return { ok: false, status: 413, code: "too_large", message: `The image is larger than ${(ATTACHMENT_MAX_BYTES / 1_000_000).toFixed(2)} MB` };
  const info = sniffImage(a.body);
  if (!info) return { ok: false, status: 400, code: "unsupported_type", message: "Only PNG, JPEG, WebP and GIF images can be attached" };
  const sha = createHash("sha256").update(a.body).digest("hex");
  const known = store.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", a.id);
  if (known) {
    return known.sha256 === sha ? { ok: true, attachment: toMessageAttachment(known), again: true }
      : { ok: false, status: 409, code: "conflict", message: "That attachment already exists" };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, a.id), a.body);
  const row: AttachmentRow = {
    id: a.id, mime: info.mime, bytes: a.body.length, sha256: sha, width: info.width, height: info.height,
    name: cleanName(a.name), device_id: a.deviceId, message_id: null, created_at: a.now,
  };
  store.run(
    "INSERT INTO attachments (id, mime, bytes, sha256, width, height, name, device_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.id, row.mime, row.bytes, row.sha256, row.width, row.height, row.name, row.device_id, null, row.created_at,
  );
  return { ok: true, attachment: toMessageAttachment(row), again: false };
}

export function attachmentRow(store: SqlStore, id: string): AttachmentRow | undefined {
  return isAttachmentId(id) ? store.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", id) : undefined;
}

/** Uploads that no message ever took (the owner removed the picture or closed the app before sending). */
export const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Removes uploads that were never sent, after a week. A picture on a message is never removed here:
 * sent pictures are kept like every other message.
 */
export function sweepOrphanAttachments(store: SqlStore, dir: string, now: number, maxAgeMs = ORPHAN_MAX_AGE_MS): number {
  const old = store.all<{ id: string }>("SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?", now - maxAgeMs);
  for (const { id } of old) {
    if (!isAttachmentId(id)) continue;
    const file = join(dir, id);
    if (existsSync(file)) rmSync(file, { force: true });
    store.run("DELETE FROM attachments WHERE id = ? AND message_id IS NULL", id);
  }
  return old.length;
}
