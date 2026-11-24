import { Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import { File as FsFile } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { ATTACHMENT_MAX_BYTES, fitWithin, isAttachmentMime, type MessageAttachment } from "@homebase/protocol";
import { encodingPlan, offeredType, pickEncoding, sendAsIs, SOFT_TARGET_BYTES, targetSize } from "./attachments";
import { useSession } from "./sync/session";

/**
 * The platform half of attaching pictures (the rules are in attachments.ts): read the picture, scale it to a
 * sensible size, and upload it once to the hub under its own id. Web and the desktop window use the browser's
 * canvas; the phone uses expo-image-manipulator and uploads the file's bytes.
 */

/** Pictures this device attached, by attachment id: shown from here at once, before (and instead of) a hub fetch. */
export const localPreviews = new Map<string, string>();

/** A picture ready to upload: a Blob in a browser, a local file on the phone. */
export type Prepared = { kind: "blob"; blob: Blob; mime: string } | { kind: "file"; uri: string; mime: string };

// ---------------------------------------------------------------- web and desktop

async function decodeBlob(blob: Blob): Promise<{ draw: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === "function") {
    const b = await createImageBitmap(blob);
    return { draw: b, width: b.width, height: b.height, close: () => b.close() };
  }
  const url = URL.createObjectURL(blob);
  const img = new window.Image();
  img.src = url;
  await img.decode();
  return { draw: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

/** A picture from a paste, a drop or the file picker, scaled and encoded for the hub. Throws with words the owner can read. */
export async function prepareBlob(file: Blob, name: string | null): Promise<Prepared> {
  const type = offeredType(file.type, name);
  if (!type.ok) throw new Error(type.reason);
  let d: Awaited<ReturnType<typeof decodeBlob>>;
  try {
    d = await decodeBlob(file);
  } catch {
    throw new Error(`${name ? `"${name}"` : "That image"} could not be read.`);
  }
  try {
    if (!type.convert && sendAsIs({ mime: file.type, bytes: file.size, width: d.width, height: d.height })) return { kind: "blob", blob: file, mime: file.type };
    // A GIF that fits as it is keeps its animation.
    if (file.type === "image/gif" && file.size <= ATTACHMENT_MAX_BYTES && !fitWithin(d.width, d.height).scaled) return { kind: "blob", blob: file, mime: file.type };
    const { width, height } = targetSize(d.width, d.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This window cannot scale images.");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const tries: Array<{ blob: Blob; bytes: number; mime: string }> = [];
    for (const enc of encodingPlan(type.convert ? "image/png" : file.type)) {
      g.clearRect(0, 0, width, height);
      if (enc.mime === "image/jpeg") {
        g.fillStyle = "#FFFFFF"; // JPEG has no transparency: a see-through screenshot gets a white page, not a black one
        g.fillRect(0, 0, width, height);
      }
      g.drawImage(d.draw, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, enc.mime, enc.quality));
      if (!blob || blob.type !== enc.mime) continue; // a browser that cannot write this type falls back to PNG; skip it
      tries.push({ blob, bytes: blob.size, mime: enc.mime });
      if (blob.size <= SOFT_TARGET_BYTES) break;
    }
    const pick = pickEncoding(tries);
    if (!pick) throw new Error("That image is too large to attach, even scaled down.");
    return { kind: "blob", blob: pick.blob, mime: pick.mime };
  } finally {
    d.close();
  }
}

/** The image files in a paste or a drop. Other files are counted, so the owner hears why they were left out. */
export function imagesFromTransfer(dt: DataTransfer | null): { files: File[]; others: string[] } {
  const files: File[] = [];
  const others: string[] = [];
  if (!dt) return { files, others };
  const seen = new Set<File>();
  // Items first (a pasted screenshot is only an item), then files (a drop from Explorer).
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const f = it.getAsFile();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    if (f.type.startsWith("image/")) files.push(f);
    else others.push(f.name || f.type || "a file");
  }
  if (!files.length && !others.length) {
    for (const f of Array.from(dt.files ?? [])) {
      if (f.type.startsWith("image/")) files.push(f);
      else others.push(f.name || "a file");
    }
  }
  return { files, others };
}

/** Opens the browser's file picker for images. Resolves with what was chosen (nothing when cancelled). */
export function chooseFilesWeb(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
    input.multiple = true;
    input.style.display = "none";
    let done = false;
    const finish = (files: File[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

// ---------------------------------------------------------------- the phone

/** A picture from the phone's photo library, camera or clipboard. */
export interface NativePick {
  uri: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  name: string | null;
}

/** Scales and encodes a phone picture into a local file for upload. Throws with words the owner can read. */
export async function prepareNative(p: NativePick): Promise<Prepared> {
  const type = p.mime ? offeredType(p.mime, p.name) : ({ ok: true, convert: true } as const);
  if (!type.ok) throw new Error(type.reason);
  if (!type.convert && p.mime && p.width && p.height && p.bytes != null && sendAsIs({ mime: p.mime, bytes: p.bytes, width: p.width, height: p.height }) && p.uri.startsWith("file:")) {
    return { kind: "file", uri: p.uri, mime: p.mime };
  }
  let img = await ImageManipulator.manipulate(p.uri).renderAsync();
  const size = targetSize(img.width, img.height);
  if (size.scaled) img = await ImageManipulator.manipulate(img).resize({ width: size.width, height: size.height }).renderAsync();
  const tries: Array<{ uri: string; bytes: number; mime: string }> = [];
  for (const enc of encodingPlan(type.convert || !p.mime || !isAttachmentMime(p.mime) || p.mime === "image/gif" ? "image/png" : p.mime)) {
    const format = enc.mime === "image/png" ? SaveFormat.PNG : enc.mime === "image/webp" ? SaveFormat.WEBP : SaveFormat.JPEG;
    const r = await img.saveAsync({ format, compress: enc.quality ?? 1 });
    const bytes = new FsFile(r.uri).size ?? 0;
    tries.push({ uri: r.uri, bytes, mime: enc.mime });
    if (bytes <= SOFT_TARGET_BYTES) break;
  }
  const pick = pickEncoding(tries);
  if (!pick) throw new Error("That image is too large to attach, even scaled down.");
  return { kind: "file", uri: pick.uri, mime: pick.mime };
}

const asPick = (a: { uri: string; mimeType?: string | null; width?: number; height?: number; fileSize?: number | null; fileName?: string | null }): NativePick => ({
  uri: a.uri, mime: a.mimeType ?? null, width: a.width || null, height: a.height || null, bytes: a.fileSize ?? null, name: a.fileName ?? null,
});

/** The phone's photo library, several at once. Android's own photo picker needs no permission. */
export async function pickFromLibrary(limit: number): Promise<NativePick[]> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: limit > 1, selectionLimit: Math.max(1, limit), quality: 1, exif: false });
  return r.canceled ? [] : r.assets.map(asPick);
}

/** One photo from the camera. Asks for the camera permission the first time. */
export async function takePhoto(): Promise<NativePick[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("HomeBase may not use the camera. Allow it in Android Settings → Apps → HomeBase → Permissions.");
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, exif: false });
  return r.canceled ? [] : r.assets.map(asPick);
}

/** The picture on the phone's clipboard, if there is one (a screenshot copied from another app). */
export async function clipboardPicture(): Promise<NativePick | null> {
  if (!(await Clipboard.hasImageAsync())) return null;
  const img = await Clipboard.getImageAsync({ format: "png" });
  if (!img?.data) return null;
  return { uri: img.data, mime: null, width: img.size?.width || null, height: img.size?.height || null, bytes: null, name: null };
}

// ---------------------------------------------------------------- upload

/** Uploads one prepared picture to the hub under `id`. The token goes in the Authorization header, never in the address. */
export async function uploadPicture(id: string, p: Prepared, name: string | null): Promise<MessageAttachment> {
  const session = useSession.getState().session;
  if (!session) throw new Error("This device is not paired.");
  const url = `${session.url}/v1/attachments/${id}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${session.token}`, "Content-Type": p.mime, ...(name ? { "X-File-Name": encodeURIComponent(name) } : {}) };
  let res: { ok: boolean; status: number; json(): Promise<any> };
  try {
    if (p.kind === "blob") res = await fetch(url, { method: "PUT", headers, body: p.blob });
    else {
      const bytes = await new FsFile(p.uri).bytes();
      res = await expoFetch(url, { method: "PUT", headers, body: bytes });
    }
  } catch {
    throw new Error("The hub could not be reached. Check the connection and attach the image again.");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `The hub answered ${res.status}.`);
  return json.attachment as MessageAttachment;
}

/** A preview the device can show while the picture uploads. */
export function previewOf(p: Prepared): string {
  return p.kind === "blob" ? URL.createObjectURL(p.blob) : p.uri;
}

export const isWeb = Platform.OS === "web";
