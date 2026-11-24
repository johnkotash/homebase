import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { newId, previewIdOf, type ImageMaker } from "@homebase/protocol";
import { isInside, isSensitivePath } from "../policy";

/**
 * Where images made in sessions live on the connector machine, and how their bytes reach the hub.
 *
 *   <data>/artifacts/<session>/<id>.<ext> (+ .json)   the connector's own copy, with what was asked and who made it
 *   <working directory>/assets/generated/             the copy the owner and the agent work with
 *   <working directory>/brand/                        logos and other things to build on (reference images)
 *   <data>/image-ledger.jsonl                         one line per attempt, for the hourly cap
 */

export const SAVE_DIR = "assets/generated";
export const BRAND_DIR = "brand";
const RASTER = /\.(png|jpe?g|webp)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
export const mimeOf = (file: string) => MIME[extname(file).toLowerCase()] ?? "application/octet-stream";

/** A file name made of the words of a title: "Spring sale post!" -> "spring-sale-post". */
export function slugify(text: string, max = 48): string {
  const s = String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return s || "image";
}

/** A short, readable name from a brief, for when the agent gave none. */
export function nameFromPrompt(prompt: string): string {
  const words = String(prompt ?? "").replace(/["'`]/g, "").split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).slice(0, 6).join(" ");
  return words.slice(0, 60) || "Image";
}

export interface SavedImage {
  id: string;
  /** The connector's own copy. */
  artifactPath: string;
  /** The copy in the working directory. Null when it could not be written there. */
  savedPath: string | null;
  /** True when the hub has the bytes. */
  stored: boolean;
  /** The id of the PNG preview, when one was stored. */
  previewId: string | null;
}

export interface LedgerLine {
  at: number;
  maker: ImageMaker;
  ok: boolean;
  runId: string;
  threadId: string | null;
  seconds?: number | null;
  name?: string;
  reason?: string;
}

export interface ImageStoreOptions {
  dataDir: string;
  /** The hub to send bytes to. Null: nothing is uploaded (the card then says the file is on this machine). */
  hub: () => { url: string; token: string } | null;
  fetchFn?: typeof fetch;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

export class ImageStore {
  readonly artifactsDir: string;
  readonly ledgerPath: string;
  private now: () => number;
  private fetchFn: typeof fetch;
  private log: (...a: unknown[]) => void;

  constructor(private o: ImageStoreOptions) {
    this.artifactsDir = resolve(o.dataDir, "artifacts");
    this.ledgerPath = resolve(o.dataDir, "image-ledger.jsonl");
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetchFn ?? fetch;
    this.log = o.log ?? (() => {});
  }

  /** This session's folder in the connector's own store. */
  threadDir(threadId: string | null): string {
    return join(this.artifactsDir, (threadId ?? "no-session").replace(/[^\w-]/g, "_"));
  }

  /**
   * A reference image the agent named, as an absolute path, or the reason it is refused. It must be a PNG,
   * JPEG or WebP that exists inside the working directory (the brand folder, assets, anywhere in the
   * project) or among this session's own images. A bare file name is looked up in those places.
   */
  resolveReference(input: unknown, cwd: string, threadId: string | null, opts: { svg?: boolean } = {}): { ok: true; path: string } | { ok: false; reason: string } {
    if (typeof input !== "string" || !input.trim()) return { ok: false, reason: "A reference image must be a file path." };
    const raw = input.trim();
    const roots = [resolve(cwd), this.threadDir(threadId)];
    const candidates = isAbsolute(raw) ? [resolve(raw)]
      : [resolve(cwd, raw), resolve(cwd, BRAND_DIR, raw), resolve(cwd, SAVE_DIR, raw), resolve(this.threadDir(threadId), raw)];
    for (const abs of candidates) {
      if (!roots.some((r) => isInside(abs, r))) continue;
      if (isSensitivePath(abs)) return { ok: false, reason: "That file is off limits." };
      if (!RASTER.test(abs) && !(opts.svg && /.svg$/i.test(abs))) continue;
      try {
        if (statSync(abs).isFile()) return { ok: true, path: abs };
      } catch {
        // try the next place
      }
    }
    return {
      ok: false,
      reason: `"${basename(raw).slice(0, 80)}" is not a PNG, JPEG or WebP inside this session's working directory. Reference images belong in its ${BRAND_DIR}/ or ${SAVE_DIR}/ folder.`,
    };
  }

  /** Stores one finished image: the connector's copy with its sidecar, the copy in the working directory, and the bytes on the hub. */
  async save(a: {
    threadId: string | null; cwd: string; name: string; ext: ".png" | ".jpg" | ".webp" | ".svg"; bytes: Buffer;
    /** A PNG the clients can always draw (the rendered SVG). Stored next to the image. */
    preview?: Buffer | null;
    /** For a Claude overlay: the SVG itself, kept beside the composed picture so it can be edited or reused. */
    source?: { ext: ".svg"; bytes: Buffer } | null;
    meta: Record<string, unknown>;
  }): Promise<SavedImage> {
    const id = newId("art");
    const dir = this.threadDir(a.threadId);
    mkdirSync(dir, { recursive: true });
    const artifactPath = join(dir, `${id}${a.ext}`);
    writeFileSync(artifactPath, a.bytes);
    if (a.preview) writeFileSync(join(dir, `${id}.preview.png`), a.preview);
    if (a.source) writeFileSync(join(dir, `${id}.overlay${a.source.ext}`), a.source.bytes);

    let savedPath: string | null = null;
    try {
      const out = resolve(a.cwd, SAVE_DIR);
      mkdirSync(out, { recursive: true });
      // The owner's own date (this machine's clock), so a file made on Sunday evening is not named for Monday.
      const d = new Date(this.now());
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const stem = `${day}-${slugify(a.name)}`;
      let file = join(out, `${stem}${a.ext}`);
      for (let n = 2; existsSync(file) && n < 500; n++) file = join(out, `${stem}-${n}${a.ext}`);
      copyFileSync(artifactPath, file);
      if (a.source) writeFileSync(file.replace(/\.[^.]+$/, `.overlay${a.source.ext}`), a.source.bytes);
      savedPath = file;
      // One line per image, so the folder says what each file is and who made it without a sidecar per file.
      appendFileSync(join(out, "index.jsonl"), JSON.stringify({ file: basename(file), at: new Date(this.now()).toISOString(), ...a.meta }) + "\n");
    } catch (err) {
      this.log(`images: could not save into the working directory: ${(err as Error).message}`);
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, at: new Date(this.now()).toISOString(), savedPath, ...a.meta }, null, 2));

    const stored = await this.upload(id, mimeOf(artifactPath), a.bytes);
    const previewId = a.preview && stored && (await this.upload(previewIdOf(id), "image/png", a.preview)) ? previewIdOf(id) : null;
    return { id, artifactPath, savedPath, stored, previewId };
  }

  /** Sends the bytes to the hub so every device can show the image. Three tries; false when the hub cannot be reached. */
  async upload(id: string, mime: string, bytes: Buffer): Promise<boolean> {
    const hub = this.o.hub();
    if (!hub) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(`${hub.url.replace(/\/+$/, "")}/v1/artifacts/${id}`, {
          method: "PUT", headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": mime }, body: new Uint8Array(bytes),
        });
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500) {
          this.log(`images: the hub refused ${id} (${res.status})`);
          return false;
        }
      } catch (err) {
        if (attempt === 2) this.log(`images: could not send ${id} to the hub: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    return false;
  }

  /** Copies a finished image into the working directory's brand folder. Returns the new path. */
  toBrand(file: string, cwd: string): string {
    const out = resolve(cwd, BRAND_DIR);
    mkdirSync(out, { recursive: true });
    // The date prefix belongs to the generated folder; a brand asset keeps the plain name.
    const name = basename(file).replace(/^\d{4}-\d{2}-\d{2}-/, "");
    let dest = join(out, name);
    for (let n = 2; existsSync(dest) && n < 500; n++) dest = join(out, name.replace(/(\.[^.]+)$/, `-${n}$1`));
    copyFileSync(file, dest);
    return dest;
  }

  record(line: LedgerLine) {
    try {
      mkdirSync(resolve(this.o.dataDir), { recursive: true });
      appendFileSync(this.ledgerPath, JSON.stringify(line) + "\n");
    } catch (err) {
      this.log(`images: could not write the ledger: ${(err as Error).message}`);
    }
  }

  /** Images a maker was asked for in the last hour (made or not: an attempt uses the plan either way). */
  countLastHour(maker: ImageMaker): number {
    let text = "";
    try {
      text = readFileSync(this.ledgerPath, "utf8");
    } catch {
      return 0;
    }
    const since = this.now() - 3_600_000;
    let n = 0;
    for (const l of text.split(/\r?\n/).slice(-2000)) {
      if (!l.trim()) continue;
      try {
        const j = JSON.parse(l) as LedgerLine;
        if (j.maker === maker && j.at >= since && j.reason !== "not_ready" && j.reason !== "cap") n++;
      } catch {
        // a damaged line is skipped
      }
    }
    return n;
  }
}

/** A path as the owner should read it: relative to the working directory when it is inside it. */
export function shownPath(file: string, cwd: string): string {
  const rel = relative(resolve(cwd), resolve(file));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : file;
}
