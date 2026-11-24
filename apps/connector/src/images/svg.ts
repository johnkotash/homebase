/**
 * Graphics the Claude agent draws itself: an SVG, checked before it is stored or shown.
 *
 * The SVG comes from a model, so it is treated as untrusted markup. It may contain shapes, text, gradients,
 * filters and embedded raster data. It may not contain anything that runs, loads from elsewhere or
 * declares entities. What passes is stored as written. A PNG preview (and an overlay put on top of
 * another picture) is made with `sharp` when that library is on the machine; without it the SVG is
 * still stored and the browser draws it.
 */

export const SVG_MAX_BYTES = 400_000;

export type SvgCheck = { ok: true; svg: string; width: number | null; height: number | null } | { ok: false; reason: string };

const FORBIDDEN: Array<[RegExp, string]> = [
  [/<!DOCTYPE/i, "a DOCTYPE"],
  [/<!ENTITY/i, "an entity declaration"],
  [/<\s*script\b/i, "a <script> element"],
  [/<\s*foreignObject\b/i, "a <foreignObject> element"],
  [/<\s*(iframe|embed|object|audio|video|link|meta|style\s+[^>]*src)\b/i, "an embedded document"],
  [/\son[a-z]+\s*=/i, "an event handler attribute"],
  [/javascript\s*:/i, "a javascript: link"],
  [/@import\b/i, "an @import rule"],
  [/<\?xml-stylesheet/i, "an external stylesheet"],
];

/** Every href, xlink:href or src must point inside the file (#id) or be embedded raster data. */
const LINK = /\b(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const OK_LINK = /^(#[\w:.-]+|data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+)$/;
/** url(...) in a style or attribute may only name something inside the file. */
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

const num = (v: string | undefined) => {
  const m = v ? /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(v) : null;
  return m ? Math.round(Number(m[1])) : null;
};

export function checkSvg(input: unknown): SvgCheck {
  if (typeof input !== "string") return { ok: false, reason: "The SVG must be text." };
  let svg = input.replace(/^﻿/, "").trim();
  // A fenced block or an XML declaration around it is common and harmless.
  svg = svg.replace(/^```(?:svg|xml)?\s*/i, "").replace(/\s*```$/, "").replace(/^<\?xml[^>]*\?>\s*/i, "").trim();
  if (Buffer.byteLength(svg, "utf8") > SVG_MAX_BYTES) return { ok: false, reason: `The SVG is larger than ${Math.round(SVG_MAX_BYTES / 1000)} KB. Simplify it.` };
  const open = /^<svg\b([^>]*)>/i.exec(svg);
  if (!open || !/<\/svg>\s*$/i.test(svg)) return { ok: false, reason: "It must be one complete <svg>…</svg> element and nothing else." };
  for (const [re, what] of FORBIDDEN) if (re.test(svg)) return { ok: false, reason: `It contains ${what}, which is not allowed. Use plain shapes, text, gradients and filters.` };
  for (const m of svg.matchAll(LINK)) {
    const target = (m[1] ?? m[2] ?? "").trim();
    if (!OK_LINK.test(target)) return { ok: false, reason: "It links to something outside the file. Only #ids and embedded PNG, JPEG or WebP data are allowed; put a picture underneath with base_image instead." };
  }
  for (const m of svg.matchAll(CSS_URL)) {
    if (!/^#[\w:.-]+$/.test(m[2].trim())) return { ok: false, reason: "It uses url(...) for something outside the file. Only url(#id) is allowed, and no web fonts: use generic font families." };
  }
  let attrs = open[1];
  if (!/\bxmlns\s*=/.test(attrs)) {
    svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    attrs = ` xmlns="http://www.w3.org/2000/svg"${attrs}`;
  }
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  let width = num(attr("width")?.[1] ?? attr("width")?.[2]);
  let height = num(attr("height")?.[1] ?? attr("height")?.[2]);
  const vb = (attr("viewBox")?.[1] ?? attr("viewBox")?.[2] ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    width = width ?? Math.round(vb[2]);
    height = height ?? Math.round(vb[3]);
  }
  if (!width || !height) return { ok: false, reason: "Give the <svg> a viewBox (and ideally width and height), so it has a size." };
  if (width > 8192 || height > 8192) return { ok: false, reason: "It is larger than 8192 px on a side." };
  return { ok: true, svg, width, height };
}

/** Width and height of a PNG, JPEG or WebP from its header. Null when the bytes are something else. */
export function imageSize(buf: Buffer): { width: number; height: number; mime: string } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: "image/png" };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: "image/jpeg" };
      }
      i += 2 + len;
    }
    return null;
  }
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), mime: "image/webp" };
    if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, mime: "image/webp" };
    if (kind === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, mime: "image/webp" };
    }
  }
  return null;
}

/** Turns SVGs into pixels. Present only when `sharp` can be loaded on this machine. */
export interface SvgRenderer {
  /** The SVG as a PNG, at least `minWidth` wide. */
  png(svg: string, size: { width: number; height: number }, minWidth?: number): Promise<Buffer>;
  /** The SVG stretched over a picture, as one PNG the size of the picture. */
  overlay(base: Buffer, svg: string): Promise<{ png: Buffer; width: number; height: number }>;
}

let cached: Promise<SvgRenderer | null> | null = null;

/** The renderer, or null when `sharp` is not installed here. Loaded once. */
export function loadRenderer(): Promise<SvgRenderer | null> {
  cached ??= (async () => {
    let sharp: any;
    try {
      const name = "sharp"; // not a declared dependency of the connector: used when the machine has it
      const mod: any = await import(name);
      sharp = mod.default ?? mod;
      await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')).png().toBuffer();
    } catch {
      return null;
    }
    const renderer: SvgRenderer = {
      async png(svg, size, minWidth = 1080) {
        const target = Math.min(4096, Math.max(size.width, minWidth));
        // Rendered at the density that gives the target width, so text and curves stay sharp.
        const density = Math.max(72, Math.min(600, Math.round((72 * target) / size.width)));
        return sharp(Buffer.from(svg), { density }).resize({ width: target }).png().toBuffer();
      },
      async overlay(base, svg) {
        const meta = await sharp(base).metadata();
        const width = Number(meta.width);
        const height = Number(meta.height);
        if (!width || !height) throw new Error("The base image could not be read.");
        const layer = await sharp(Buffer.from(svg), { density: 300 }).resize(width, height, { fit: "fill" }).png().toBuffer();
        return { png: await sharp(base).composite([{ input: layer }]).png().toBuffer(), width, height };
      },
    };
    return renderer;
  })();
  return cached;
}
