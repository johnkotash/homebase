import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CAPABILITY, ATTACHMENT_MAX_BYTES, MAX_ATTACHMENTS, MUTATIONS, Message, MessageAttachment, RunInputCmd, RunStartCmd,
  acceptsAttachments, attachmentRefusal, attachmentsProblem, attachmentsSummary, buildSessionRows, fitWithin, isAttachmentId, messagePreview, newId, sniffImage,
} from "../src";

// A 1 x 1 PNG, and hand-made headers for the other types.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
function jpeg(w: number, h: number) {
  // SOI, an APP0 segment, then SOF0 with the size.
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, ...Array(9).fill(0), 0xff, 0xd9]);
}
const gif = (w: number, h: number) => Uint8Array.from([...Buffer.from("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
function webpX(w: number, h: number) {
  const b = new Uint8Array(30);
  b.set(Buffer.from("RIFF"), 0);
  b.set(Buffer.from("WEBPVP8X"), 8);
  const W = w - 1;
  const H = h - 1;
  b.set([W & 255, (W >> 8) & 255, (W >> 16) & 255, H & 255, (H >> 8) & 255, (H >> 16) & 255], 24);
  return b;
}
const att = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({ id: newId("att"), kind: "image", mime: "image/png", bytes: 1000, width: 10, height: 10, ...over });

describe("what a picture really is", () => {
  it("reads the type and the size from the first bytes", () => {
    expect(sniffImage(PNG)).toEqual({ mime: "image/png", width: 1, height: 1 });
    expect(sniffImage(jpeg(1920, 1080))).toEqual({ mime: "image/jpeg", width: 1920, height: 1080 });
    expect(sniffImage(gif(320, 200))).toEqual({ mime: "image/gif", width: 320, height: 200 });
    expect(sniffImage(webpX(2000, 1125))).toEqual({ mime: "image/webp", width: 2000, height: 1125 });
  });
  it("refuses anything else, whatever its name or claimed type", () => {
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe("the limits", () => {
  it("a long edge over 2000 px is scaled down, keeping the shape; smaller pictures are never scaled up", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500, scaled: true });
    expect(fitWithin(1080, 2520)).toEqual({ width: 857, height: 2000, scaled: true });
    expect(fitWithin(1920, 1080)).toEqual({ width: 1920, height: 1080, scaled: false });
  });
  it("count, type, each size and the total are checked", () => {
    expect(attachmentsProblem([att(), att()])).toBeNull();
    expect(attachmentsProblem(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => att()))).toMatch(/At most 6/);
    expect(attachmentsProblem([{ mime: "image/svg+xml", bytes: 10 }])).toMatch(/PNG, JPEG, WebP and GIF/);
    expect(attachmentsProblem([att({ bytes: ATTACHMENT_MAX_BYTES + 1 })])).toMatch(/Each image/);
    expect(attachmentsProblem(Array.from({ length: 5 }, () => att({ bytes: 3_500_000 })))).toMatch(/together/);
  });
  it("ids are att_ ids only", () => {
    expect(isAttachmentId(newId("att"))).toBe(true);
    expect(isAttachmentId(newId("art"))).toBe(false);
    expect(isAttachmentId("att_../../etc/passwd")).toBe(false);
  });
});

describe("which agents take pictures", () => {
  it("only an agent whose connector says so; the refusal names the agent", () => {
    expect(acceptsAttachments({ capabilities: ["code", ATTACHMENT_CAPABILITY] })).toBe(true);
    expect(acceptsAttachments({ capabilities: ["code"] })).toBe(false);
    expect(acceptsAttachments(null)).toBe(false);
    expect(attachmentRefusal({ name: "Dev agent" })).toBe("Dev agent can't take images. Remove the pictures to send the text, or ask an agent that can see images.");
  });
});

describe("messages with pictures", () => {
  it("a message may carry pictures and no words; the schemas accept it, and commands carry the facts", () => {
    const a = att();
    expect(MUTATIONS["message.send"].safeParse({ threadId: "t", messageId: "m", text: "", source: "text", attachments: [a] }).success).toBe(true);
    expect(MUTATIONS["message.send"].safeParse({ threadId: "t", messageId: "m", text: "hi", source: "text", attachments: Array(7).fill(a) }).success).toBe(false);
    expect(Message.safeParse({ id: "m", threadId: "t", role: "user", text: "", source: "text", runId: null, authorDeviceId: null, createdAt: 1, attachments: [a] }).success).toBe(true);
    expect(Message.safeParse({ id: "m", threadId: "t", role: "user", text: "x", source: "text", runId: null, authorDeviceId: null, createdAt: 1, attachments: null }).success).toBe(true);
    expect(RunStartCmd.parse({ t: "cmd", id: "c", name: "run.start", run: { id: "r", agentKey: "k", threadId: null, prompt: "", cwd: null, resumeSessionRef: null, attachments: [a] } }).run.attachments).toEqual([a]);
    expect(RunInputCmd.parse({ t: "cmd", id: "c", name: "run.input", runId: "r", text: "and this", attachments: [a] }).attachments).toEqual([a]);
  });
  it("lists say what is attached", () => {
    expect(attachmentsSummary(1)).toBe("1 image");
    expect(attachmentsSummary(3)).toBe("3 images");
    expect(messagePreview({ text: "what is wrong here?", attachments: [att()] })).toBe("what is wrong here? [1 image]");
    expect(messagePreview({ text: "", attachments: [att(), att()] })).toBe("[2 images]");
    expect(messagePreview({ text: "plain", attachments: null })).toBe("plain");
  });
  it("the session list shows a picture-only message as its pictures", () => {
    const thread = { id: "t1", title: "Bug", agentId: null, lastMessageAt: 5, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 5 } as any;
    const rows = buildSessionRows({ threads: [thread], projects: {}, agents: {}, messages: [{ id: "m", threadId: "t1", role: "user", text: "", source: "text", runId: null, authorDeviceId: null, createdAt: 5, attachments: [att()] }] } as any);
    expect(rows[0].last?.text).toBe("[1 image]");
  });
});
