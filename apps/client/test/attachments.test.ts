import { describe, expect, it } from "vitest";
import { ATTACHMENT_CAPABILITY, ATTACHMENT_MAX_BYTES, newId, type MessageAttachment } from "@homebase/protocol";
import {
  SOFT_TARGET_BYTES, attachState, draftsLine, encodingPlan, offeredType, overflowText, pasteAction, pastedName, pickEncoding, roomLeft, sendAsIs, sendState, targetSize, thumbGrid,
  type DraftPicture,
} from "../src/attachments";

const att = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({ id: newId("att"), kind: "image", mime: "image/png", bytes: 1000, width: 10, height: 10, ...over });
const draft = (status: DraftPicture["status"], over: Partial<DraftPicture> = {}): DraftPicture => ({
  id: newId("att"), status, preview: null, name: null, attachment: status === "ready" ? att() : null, error: status === "error" ? "nope" : null, ...over,
});

describe("which composer gets pictures", () => {
  it("an agent that can look at pictures, and a thread with no agent; any other agent is named in the refusal", () => {
    expect(attachState({ name: "Claude agent", capabilities: ["code", ATTACHMENT_CAPABILITY] }, true)).toEqual({ canAttach: true, refusal: null });
    expect(attachState(null, false)).toEqual({ canAttach: true, refusal: null });
    const no = attachState({ name: "Ops agent", capabilities: ["logs"] }, true);
    expect(no.canAttach).toBe(false);
    expect(no.refusal).toMatch(/^Ops agent can't take images/);
  });
});

describe("pasting", () => {
  it("a snip (picture, no text) attaches; text with a picture of itself (Excel, Word) pastes as text", () => {
    expect(pasteAction({ text: "", images: 1 })).toBe("attach");
    expect(pasteAction({ text: undefined, images: 2 })).toBe("attach");
    expect(pasteAction({ text: "A1\tB1", images: 1 })).toBe("text");
    expect(pasteAction({ text: "hello", images: 0 })).toBe("text");
    expect(pasteAction({ text: "", images: 0 })).toBe("text");
  });
  it("a pasted picture gets a name with the time", () => {
    expect(pastedName("image/png", new Date(2026, 10, 23, 9, 5, 7))).toBe("Pasted 2026-11-23 090507.png");
    expect(pastedName("image/jpeg", new Date(2026, 0, 2, 13, 0, 0))).toBe("Pasted 2026-01-02 130000.jpg");
  });
});

describe("what can be attached", () => {
  it("PNG, JPEG, WebP and GIF as they are; BMP converted; HEIC, SVG and other files refused with the reason", () => {
    expect(offeredType("image/png")).toEqual({ ok: true, convert: false });
    expect(offeredType("image/gif")).toEqual({ ok: true, convert: false });
    expect(offeredType("image/bmp")).toEqual({ ok: true, convert: true });
    expect(offeredType("image/heic", "IMG_1.HEIC")).toEqual({ ok: false, reason: '"IMG_1.HEIC" is a HEIC photo. Only PNG, JPEG, WebP and GIF images can be attached.' });
    expect(offeredType("image/svg+xml")).toMatchObject({ ok: false });
    expect(offeredType("application/pdf", "invoice.pdf")).toEqual({ ok: false, reason: '"invoice.pdf" is not an image HomeBase can attach. Use PNG, JPEG, WebP or GIF.' });
  });
  it("six per message: the composer says how many more fit", () => {
    expect(roomLeft([draft("ready"), draft("uploading")])).toBe(4);
    expect(overflowText(3, 4)).toBeNull();
    expect(overflowText(5, 2)).toBe("Only 2 more images fit on this message (at most 6).");
    expect(overflowText(1, 0)).toBe("At most 6 images per message.");
  });
});

describe("scaling and encoding", () => {
  it("a small screenshot goes as it is, pixel-exact; a big or oversized one is scaled to 2000 px on the long edge", () => {
    expect(sendAsIs({ mime: "image/png", bytes: 400_000, width: 1920, height: 1080 })).toBe(true);
    expect(sendAsIs({ mime: "image/png", bytes: 400_000, width: 3840, height: 2160 })).toBe(false);
    expect(sendAsIs({ mime: "image/png", bytes: SOFT_TARGET_BYTES + 1, width: 1200, height: 900 })).toBe(false);
    expect(sendAsIs({ mime: "image/bmp", bytes: 1000, width: 10, height: 10 })).toBe(false);
    expect(targetSize(3840, 2160)).toEqual({ width: 2000, height: 1125, scaled: true });
  });
  it("a PNG stays PNG when it can, then JPEG at falling quality; a photo stays JPEG", () => {
    expect(encodingPlan("image/png").map((e) => `${e.mime}${e.quality ? `@${e.quality}` : ""}`)).toEqual(["image/png", "image/jpeg@0.9", "image/jpeg@0.8", "image/jpeg@0.65", "image/jpeg@0.5"]);
    expect(encodingPlan("image/jpeg")[0]).toEqual({ mime: "image/jpeg", quality: 0.88 });
    expect(encodingPlan("image/webp")[0]).toEqual({ mime: "image/webp", quality: 0.9 });
  });
  it("keeps the first try under the soft target, else the smallest under the limit, else nothing", () => {
    expect(pickEncoding([{ bytes: 3_000_000, n: 1 }, { bytes: 900_000, n: 2 }, { bytes: 500_000, n: 3 }])).toEqual({ bytes: 900_000, n: 2 });
    expect(pickEncoding([{ bytes: 3_600_000, n: 1 }, { bytes: 2_900_000, n: 2 }])).toEqual({ bytes: 2_900_000, n: 2 });
    expect(pickEncoding([{ bytes: ATTACHMENT_MAX_BYTES + 1 }])).toBeNull();
  });
});

describe("sending", () => {
  it("words or pictures are something to send; pictures still uploading make send wait; failed ones hold it", () => {
    expect(sendState("", []).hasContent).toBe(false);
    expect(sendState("hi", []).hasContent).toBe(true);
    const s = sendState("", [draft("ready"), draft("uploading"), draft("error")]);
    expect(s).toMatchObject({ hasContent: true, waiting: 1, failed: 1 });
    expect(s.ready).toHaveLength(1);
  });
  it("the line under the box", () => {
    expect(draftsLine([draft("ready")], false)).toBeNull();
    expect(draftsLine([draft("uploading"), draft("preparing")], false)).toEqual({ text: "Uploading 2 images…", warn: false });
    expect(draftsLine([draft("uploading")], true)).toEqual({ text: "Sending as soon as the images are uploaded…", warn: false });
    expect(draftsLine([draft("error"), draft("uploading")], true)).toEqual({ text: "An image could not be attached. Remove it to send.", warn: true });
  });
  it("thumbnails in a sent message: one large, two or four in pairs, otherwise three across", () => {
    expect(thumbGrid(1, 320)).toEqual({ columns: 1, tile: 280 });
    expect(thumbGrid(2, 320).columns).toBe(2);
    expect(thumbGrid(4, 320).columns).toBe(2);
    expect(thumbGrid(5, 320)).toEqual({ columns: 3, tile: 97 });
  });
});
