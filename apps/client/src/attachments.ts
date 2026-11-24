import {
  ATTACHMENT_MAX_BYTES, MAX_ATTACHMENTS, acceptsAttachments, attachmentRefusal, attachmentsProblem, fitWithin, isAttachmentMime,
  type Agent, type AttachmentMime, type MessageAttachment,
} from "@homebase/protocol";

/**
 * Pictures on a message, before and after sending: the rules the composer follows on the phone and the desktop
 * alike. Pure (no React Native), so both platforms behave the same and the tests can read it. The platform work
 * (decoding, scaling, uploading) is in attachUpload.ts.
 */

/** One picture in the composer, from the moment it is added until the message is sent. */
export interface DraftPicture {
  /** The attachment id it is uploaded under (made on the device). */
  id: string;
  status: "preparing" | "uploading" | "ready" | "error";
  /** Something the device can show right away: an object URL (web) or a file / data URI (phone). */
  preview: string | null;
  name: string | null;
  /** Set once the hub has the picture: what it stored. */
  attachment: MessageAttachment | null;
  error: string | null;
}

/** Below this the picture goes as it is (no re-encoding, so a screenshot stays pixel-exact). */
export const SOFT_TARGET_BYTES = 2_500_000;

/** What the composer can do with pictures for this session's agent. */
export function attachState(agent: Pick<Agent, "name" | "capabilities"> | null | undefined, hasAgent: boolean): { canAttach: boolean; refusal: string | null } {
  if (!hasAgent) return { canAttach: true, refusal: null }; // a thread for the owner's own notes keeps pictures too
  return acceptsAttachments(agent) ? { canAttach: true, refusal: null } : { canAttach: false, refusal: attachmentRefusal(agent) };
}

/** How many more pictures fit on this message. */
export const roomLeft = (drafts: ReadonlyArray<DraftPicture>) => Math.max(0, MAX_ATTACHMENTS - drafts.length);

/** The words shown when more pictures were offered than fit. Null when they all fit. */
export function overflowText(offered: number, room: number): string | null {
  if (offered <= room) return null;
  return room === 0 ? `At most ${MAX_ATTACHMENTS} images per message.` : `Only ${room} more image${room === 1 ? "" : "s"} fit on this message (at most ${MAX_ATTACHMENTS}).`;
}

/**
 * Whether a file the owner offered is a picture HomeBase can attach, by its type. Types a browser or the phone can
 * decode and turn into PNG (BMP, for example) are converted; anything else is refused with a clear reason.
 */
export function offeredType(mime: string | null | undefined, name?: string | null): { ok: true; convert: boolean } | { ok: false; reason: string } {
  const m = (mime ?? "").toLowerCase();
  if (isAttachmentMime(m)) return { ok: true, convert: false };
  if (m === "image/bmp" || m === "image/x-ms-bmp" || m === "image/avif") return { ok: true, convert: true };
  const what = name?.trim() ? `"${name.trim().slice(0, 60)}"` : m ? m : "That file";
  if (m === "image/heic" || m === "image/heif") return { ok: false, reason: `${what} is a HEIC photo. Only PNG, JPEG, WebP and GIF images can be attached.` };
  if (m === "image/svg+xml") return { ok: false, reason: `${what} is an SVG. Only PNG, JPEG, WebP and GIF images can be attached.` };
  return { ok: false, reason: `${what} is not an image HomeBase can attach. Use PNG, JPEG, WebP or GIF.` };
}

/** One way to encode a picture: a type and, for JPEG and WebP, a quality from 0 to 1. */
export interface Encoding {
  mime: AttachmentMime;
  quality?: number;
}

/**
 * The encodings to try, in order, for a picture of this type once it is decoded: the first that comes out under the
 * soft target wins, else the first under the hard limit. A PNG (a screenshot) stays PNG when it can: text stays sharp.
 */
export function encodingPlan(mime: string): Encoding[] {
  const jpeg: Encoding[] = [{ mime: "image/jpeg", quality: 0.9 }, { mime: "image/jpeg", quality: 0.8 }, { mime: "image/jpeg", quality: 0.65 }, { mime: "image/jpeg", quality: 0.5 }];
  if (mime === "image/jpeg") return [{ mime: "image/jpeg", quality: 0.88 }, ...jpeg.slice(1)];
  if (mime === "image/webp") return [{ mime: "image/webp", quality: 0.9 }, ...jpeg.slice(1)];
  return [{ mime: "image/png" }, ...jpeg];
}

/** Which encoding result to keep: the first under the soft target, else the smallest under the hard limit, else none. */
export function pickEncoding<T extends { bytes: number }>(tries: T[]): T | null {
  const soft = tries.find((t) => t.bytes <= SOFT_TARGET_BYTES);
  if (soft) return soft;
  const fits = tries.filter((t) => t.bytes <= ATTACHMENT_MAX_BYTES).sort((a, b) => a.bytes - b.bytes);
  return fits[0] ?? null;
}

/** Whether a picture can go as it is: a type Claude reads, small enough, and no bigger than the long-edge limit. */
export function sendAsIs(p: { mime: string; bytes: number; width: number; height: number }): boolean {
  return isAttachmentMime(p.mime) && p.bytes <= SOFT_TARGET_BYTES && !fitWithin(p.width, p.height).scaled;
}

/** The size to scale a decoded picture to. */
export const targetSize = (width: number, height: number) => fitWithin(width, height);

/** What the send button does with the pictures in the composer. */
export function sendState(text: string, drafts: ReadonlyArray<DraftPicture>): {
  /** Something to send: words, or at least one picture on the hub. */
  hasContent: boolean;
  /** Pictures still on their way to the hub: sending waits for them. */
  waiting: number;
  /** Pictures that failed: sending is held until they are removed. */
  failed: number;
  ready: MessageAttachment[];
  problem: string | null;
} {
  const ready = drafts.flatMap((d) => (d.status === "ready" && d.attachment ? [d.attachment] : []));
  const waiting = drafts.filter((d) => d.status === "preparing" || d.status === "uploading").length;
  const failed = drafts.filter((d) => d.status === "error").length;
  return { hasContent: !!text.trim() || drafts.length > 0, waiting, failed, ready, problem: attachmentsProblem(ready) };
}

/** The line under the composer while pictures are on their way or something is wrong with them. Null: nothing to say. */
export function draftsLine(drafts: ReadonlyArray<DraftPicture>, sendQueued: boolean): { text: string; warn: boolean } | null {
  const s = sendState("", drafts);
  if (s.failed) return { text: `${s.failed === 1 ? "An image" : `${s.failed} images`} could not be attached. Remove ${s.failed === 1 ? "it" : "them"} to send.`, warn: true };
  if (s.problem) return { text: s.problem, warn: true };
  if (s.waiting) return { text: sendQueued ? "Sending as soon as the images are uploaded…" : `Uploading ${s.waiting === 1 ? "image" : `${s.waiting} images`}…`, warn: false };
  return null;
}

/** "Screenshot 2026-11-23 101500.png" for a pasted picture with no name. */
export function pastedName(mime: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
  return `Pasted ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

/** The thumbnail grid of a sent message: how many columns, and the size of each tile, for a bubble this wide. */
export function thumbGrid(count: number, width: number): { columns: number; tile: number } {
  const columns = count <= 1 ? 1 : count === 2 || count === 4 ? 2 : 3;
  const gap = 4;
  const tile = count <= 1 ? Math.min(width, 280) : Math.floor((Math.min(width, 300) - gap * (columns - 1)) / columns);
  return { columns, tile };
}

/**
 * What a paste into the message box does. Pictures only (a Win+Shift+S snip, a copied image) are attached. When the
 * clipboard also holds text (cells copied from Excel or Word come with a picture of themselves), the text is pasted
 * as before and the picture is left alone.
 */
export function pasteAction(p: { text: string | null | undefined; images: number }): "attach" | "text" {
  return p.images > 0 && !(p.text ?? "").trim() ? "attach" : "text";
}
