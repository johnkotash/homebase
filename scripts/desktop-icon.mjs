#!/usr/bin/env node
// Makes the desktop app's icon (apps/desktop/build/icon.png and icon.ico) from the client's icon, in the app's
// monochrome: the mark in white on black. Run again only if apps/client/assets/icon.png changes.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sharp = createRequire(join(root, "package.json"))("sharp");
const src = join(root, "apps", "client", "assets", "icon.png");
const out = join(root, "apps", "desktop", "build");
mkdirSync(out, { recursive: true });

// Grey levels of the source: background about 13, the lime mark about 213. Stretch them to 0 and 255 so
// the edges keep their smoothing.
const LO = 13, HI = 213;
const a = 255 / (HI - LO);
const mono = () => sharp(src).flatten({ background: "#000000" }).greyscale().linear(a, -LO * a);

const png512 = await mono().resize(512, 512).png().toBuffer();
writeFileSync(join(out, "icon.png"), png512);

// .ico with PNG entries (Windows Vista and later read these), 16 to 256 px.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((s) => mono().resize(s, s).png().toBuffer()));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
const dir = Buffer.alloc(16 * images.length);
let offset = 6 + dir.length;
images.forEach((img, i) => {
  const s = sizes[i];
  const e = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, e); // width (0 = 256)
  dir.writeUInt8(s >= 256 ? 0 : s, e + 1); // height
  dir.writeUInt8(0, e + 2); // palette
  dir.writeUInt8(0, e + 3);
  dir.writeUInt16LE(1, e + 4); // planes
  dir.writeUInt16LE(32, e + 6); // bits per pixel
  dir.writeUInt32LE(img.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
writeFileSync(join(out, "icon.ico"), Buffer.concat([header, dir, ...images]));
console.log(`[desktop-icon] wrote ${join(out, "icon.png")} and icon.ico (${sizes.join(", ")} px)`);
