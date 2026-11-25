// IDs are "<prefix>_<uuidv7>" so either side can create rows offline and they still sort by time.
export type IdPrefix =
  | "ws" | "usr" | "dev" | "con" | "agt" | "thr" | "msg" | "run" | "apr" | "inb" | "note" | "att"
  | "int" | "sla" | "ntf" | "mut" | "cmd" | "aud" | "tok" | "toolu" | "prj" | "art" | "term";

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

let lastMs = 0;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  // Monotonic within a millisecond: 12-bit counter in rand_a.
  if (now <= lastMs) {
    counter = (counter + 1) & 0xfff;
    if (counter === 0) lastMs += 1;
  } else {
    lastMs = now;
    const r = randomBytes(2);
    counter = ((r[0] << 8) | r[1]) & 0x3ff;
  }
  const ms = lastMs;
  const b = randomBytes(16);
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${uuidv7()}`;
}

export function idPrefix(id: string): string {
  const i = id.indexOf("_");
  return i < 0 ? "" : id.slice(0, i);
}

const ID_RE = /^[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isId(id: string, prefix?: IdPrefix): boolean {
  return ID_RE.test(id) && (!prefix || id.startsWith(prefix + "_"));
}
