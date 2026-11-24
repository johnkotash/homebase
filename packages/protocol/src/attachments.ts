import { z } from "zod";

/**
 * Pictures the owner attaches to a message (2026-11-23): a screenshot pasted on the desktop, photos picked or
 * taken on the phone. A device uploads each picture once to the hub (`PUT /v1/attachments/:id`, the device's
 * own token), then sends the message with the ids. The message carries only the small facts below; the bytes
 * never ride in a sync frame. The connector fetches the bytes from the hub when the run needs them and hands
 * them to the agent as image content.
 */

/** The picture types an agent can look at. Anything else is refused by the hub and by the app before upload. */
export const ATTACHMENT_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const AttachmentMime = z.enum(ATTACHMENT_MIMES);
export type AttachmentMime = z.infer<typeof AttachmentMime>;

/** At most this many pictures on one message. */
export const MAX_ATTACHMENTS = 6;
/**
 * The largest picture the hub keeps. Claude takes at most 5 MB per image as base64, which is 3.75 MB of bytes;
 * the app scales pictures down long before that (long edge ATTACHMENT_MAX_EDGE, then JPEG if still large).
 */
export const ATTACHMENT_MAX_BYTES = 3_750_000;
/** All the pictures on one message together. Keeps one agent turn well under the request size Claude accepts. */
export const ATTACHMENTS_MAX_TOTAL_BYTES = 15_000_000;
/** The app scales a picture so its long edge is at most this many pixels before uploading it. */
export const ATTACHMENT_MAX_EDGE = 2000;
/** What a connector lists in an agent's capabilities when that agent can look at pictures. */
export const ATTACHMENT_CAPABILITY = "attach:images";

const ATT_ID = /^att_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isAttachmentId = (id: unknown): id is string => typeof id === "string" && ATT_ID.test(id);
export const AttachmentId = z.string().regex(ATT_ID);

/** One picture on a message, as every device sees it. The hub fills in mime, size and pixels from the stored file. */
export const MessageAttachment = z.object({
  id: AttachmentId,
  kind: z.literal("image"),
  mime: AttachmentMime,
  bytes: z.number().int().nonnegative().max(ATTACHMENT_MAX_BYTES),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  /** The file name it had on the device, when it had one ("Screenshot 2026-11-23.png"). Shown only. */
  name: z.string().max(200).nullable().optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachment>;

export const isAttachmentMime = (m: unknown): m is AttachmentMime => typeof m === "string" && (ATTACHMENT_MIMES as readonly string[]).includes(m);

export const ATTACHMENT_EXT: Record<AttachmentMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** True when the agent says it can look at pictures. */
export function acceptsAttachments(agent: { capabilities?: string[] | null } | null | undefined): boolean {
  return !!agent?.capabilities?.includes(ATTACHMENT_CAPABILITY);
}

/** What the app and the hub say when a picture is sent to an agent that cannot look at it. Never dropped silently. */
export function attachmentRefusal(agent: { name?: string | null } | null | undefined): string {
  return agent?.name ? `${agent.name} can't take images. Remove the pictures to send the text, or ask an agent that can see images.`
    : "This session has no agent that can look at images. Remove the pictures to send the text.";
}

/** "1 image", "3 images". */
export const attachmentsSummary = (n: number) => `${n} image${n === 1 ? "" : "s"}`;

/** A message's one-line text for lists and digests: its words, else what is attached. */
export function messagePreview(m: { text: string; attachments?: ReadonlyArray<unknown> | null }): string {
  const t = m.text.trim();
  const n = m.attachments?.length ?? 0;
  if (!n) return t;
  return t ? `${t} [${attachmentsSummary(n)}]` : `[${attachmentsSummary(n)}]`;
}

/** Why a set of pictures cannot go on one message, or null when it can. */
export function attachmentsProblem(list: ReadonlyArray<{ mime?: string; bytes?: number }>): string | null {
  if (list.length > MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} images per message.`;
  for (const a of list) {
    if (!isAttachmentMime(a.mime)) return "Only PNG, JPEG, WebP and GIF images can be attached.";
    if ((a.bytes ?? 0) > ATTACHMENT_MAX_BYTES) return `Each image must be under ${mb(ATTACHMENT_MAX_BYTES)}.`;
  }
  const total = list.reduce((s, a) => s + (a.bytes ?? 0), 0);
  if (total > ATTACHMENTS_MAX_TOTAL_BYTES) return `The images on one message must be under ${mb(ATTACHMENTS_MAX_TOTAL_BYTES)} together.`;
  return null;
}
const mb = (n: number) => `${Math.round((n / 1_000_000) * 10) / 10} MB`;

/** The size a picture is scaled to so its long edge fits `max`. Never scaled up. */
export function fitWithin(width: number, height: number, max = ATTACHMENT_MAX_EDGE): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (!(long > max) || !width || !height) return { width, height, scaled: false };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

/**
 * What a picture really is, from its first bytes: the type and, when the header says, its size in pixels.
 * Null for anything that is not a PNG, JPEG, WebP or GIF, whatever it claims to be.
 */
export function sniffImage(b: Uint8Array): { mime: AttachmentMime; width: number | null; height: number | null } | null {
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a) {
    return { mime: "image/png", width: ascii(12, 4) === "IHDR" ? u32be(16) : null, height: ascii(12, 4) === "IHDR" ? u32be(20) : null };
  }
  if (b.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { mime: "image/gif", width: u16le(6), height: u16le(8) };
  if (b.length >= 16 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X" && b.length >= 30) return { mime: "image/webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && b.length >= 30) return { mime: "image/webp", width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return { mime: "image/webp", width: null, height: null };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the segments to the frame header (SOF0..SOF15, except DHT, JPG and DAC), which holds the size.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", width: u16be(i + 7), height: u16be(i + 5) };
      }
      i += 2 + u16be(i + 2);
    }
    return { mime: "image/jpeg", width: null, height: null };
  }
  return null;
}
