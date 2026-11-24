import { describe, expect, it } from "vitest";
import { MAKER_QUESTION, makerQuestion, newId, type AgentImagesStatus, type GeneratedImageCard, type Message, type Thread } from "@homebase/protocol";
import { bytesText, imageAspect, imageByline, imageMeta, imageStepTitle, imagesChip, liveImageWork, openaiLine, projectImages, shownArtifact, toolLabel } from "../src/images";
import { quickAnswer, quickQuestion } from "../src/questions";

const card = (over: Partial<GeneratedImageCard> = {}): GeneratedImageCard => ({
  type: "generated_image", artifactId: newId("art"), previewId: null, maker: "openai", via: "ChatGPT plan · via Codex CLI", model: null, name: "Spring sale post",
  prompt: "Square post", mime: "image/png", width: 1254, height: 1254, bytes: 1_160_621, seconds: 26.4, savedPath: "assets/generated/2026-11-22-spring-sale-post.png", references: [],
  routedWhy: null, base: null, stored: true, ...over,
});
const images = (over: Partial<AgentImagesStatus["openai"]> = {}): AgentImagesStatus => ({
  openai: { ready: true, cliVersion: "0.144.5", signedIn: true, method: "chatgpt", note: null, plan: "plus", usedPercent: 4, windowMins: 10080, resetsAt: null, imagesLastHour: 0, capPerHour: 20, capPerRun: 4, checkedAt: 1, ...over },
  claude: { canRender: true }, saveDir: "assets/generated", brandDir: "brand",
});
const NOTE = "Codex is not signed in on homebase-server. Run `codex login` there.";

describe("who made it, in words", () => {
  it("an OpenAI image says the plan and the route", () => {
    expect(imageByline(card())).toBe("ChatGPT plan · via Codex CLI");
  });

  it("a Claude graphic says the model, and an overlay says whose picture it is on", () => {
    expect(imageByline(card({ maker: "claude", via: "Claude plan · SVG", model: "Opus 5.5" }))).toBe("Opus 5.5 · SVG");
    expect(imageByline(card({ maker: "claude", via: "Claude plan · SVG", model: null }))).toBe("Claude plan · SVG");
    expect(imageByline(card({ maker: "claude", via: "Claude plan · SVG overlay", model: "Opus 5.5", base: { maker: "openai", name: "Shop front" }, references: ["assets/generated/shop.png"] })))
      .toBe("Opus 5.5 · SVG overlay on an OpenAI image");
    expect(imageByline(card({ maker: "claude", via: "Claude plan · SVG overlay", model: "Opus 5.5", base: null, references: ["brand/photo.jpg"] }))).toBe("Opus 5.5 · SVG overlay on your picture");
  });

  it("size, type, weight and time read as one line", () => {
    expect(imageMeta(card())).toBe("1254 × 1254 · PNG · 1.1 MB · 26 s");
    expect(imageMeta(card({ mime: "image/svg+xml", width: 1080, height: 1080, bytes: 812, seconds: null }))).toBe("1080 × 1080 · SVG · 812 B");
    expect(imageMeta(card({ width: null, height: null, bytes: 20_480 }))).toBe("PNG · 20 KB · 26 s");
    expect(bytesText(1536)).toBe("2 KB");
  });

  it("the picture is laid out by its shape, within reason, and an SVG is drawn from its PNG preview when there is one", () => {
    expect(imageAspect(card({ width: 1536, height: 1024 }))).toBe(1.5);
    expect(imageAspect(card({ width: null, height: null }))).toBe(1);
    expect(imageAspect(card({ width: 5000, height: 100 }))).toBe(3);
    const id = newId("art");
    expect(shownArtifact({ artifactId: id, previewId: `${id}p` })).toBe(`${id}p`);
    expect(shownArtifact({ artifactId: id, previewId: null })).toBe(id);
  });
});

describe("the Images chip", () => {
  it("is not shown for an agent whose connector offers no image tools", () => {
    expect(imagesChip({ images: null }, {}, null)).toBeNull();
    expect(imagesChip(undefined)).toBeNull();
  });

  it("says who makes images here and where that choice comes from", () => {
    expect(imagesChip({ images: images() }, {}, null)).toMatchObject({ route: "auto", from: "default", text: "Images: Auto", warn: false, note: null });
    expect(imagesChip({ images: images() }, {}, { imageRoute: "openai" })).toMatchObject({ route: "openai", from: "project", text: "Images: OpenAI" });
    expect(imagesChip({ images: images() }, { imageRoute: "ask" }, { imageRoute: "openai" })).toMatchObject({ route: "ask", from: "session", text: "Images: Ask me" });
  });

  it("warns when OpenAI is part of the setting and is not signed in, with the command to run", () => {
    const out = { images: images({ ready: false, signedIn: false, note: NOTE }) };
    expect(imagesChip(out, {}, null)).toMatchObject({ warn: true, note: NOTE });
    expect(imagesChip(out, { imageRoute: "openai" }, null)).toMatchObject({ warn: true });
    // Claude alone, or no images at all, does not need OpenAI.
    expect(imagesChip(out, { imageRoute: "claude" }, null)).toMatchObject({ warn: false, note: null });
    expect(imagesChip(out, { imageRoute: "off" }, null)).toMatchObject({ warn: false, text: "Images: Off" });
  });

  it("the OpenAI line is the plan and its usage, or what to do to connect it", () => {
    expect(openaiLine(images())).toEqual({ ok: true, text: "ChatGPT Plus · 4% of this week used" });
    expect(openaiLine(images({ plan: null, usedPercent: null }))).toEqual({ ok: true, text: "Signed in with ChatGPT" });
    expect(openaiLine(images({ ready: false, note: NOTE }))).toEqual({ ok: false, text: NOTE });
  });
});

describe("a project's images", () => {
  it("are the image cards in its sessions, newest first", () => {
    const thread = (id: string, projectId: string | null) => ({ id, projectId, title: id }) as unknown as Thread;
    const threads = { a: thread("a", "prj_1"), b: thread("b", "prj_2"), c: thread("c", null) };
    const msg = (threadId: string, createdAt: number, c: Message["card"]) => ({ id: newId("msg"), threadId, role: "assistant", text: "", source: "agent", runId: null, authorDeviceId: null, createdAt, card: c }) as Message;
    const list = [
      msg("a", 10, card({ name: "first" })), msg("a", 30, card({ name: "third", maker: "claude" })), msg("b", 20, card({ name: "other project" })), msg("c", 25, card({ name: "unsorted" })),
      msg("a", 40, { type: "image_issue", maker: "openai", reason: "limit", title: "x", message: "y", hint: null }), msg("a", 50, null),
    ];
    expect(projectImages(list, threads, "prj_1").map((i) => [i.card.name, i.card.maker, i.thread.id])).toEqual([["third", "claude", "a"], ["first", "openai", "a"]]);
    expect(projectImages(list, threads, "prj_3")).toEqual([]);
  });
});

describe("the run timeline", () => {
  it("names the provider on an image step and leaves every other tool as it was", () => {
    expect(toolLabel("mcp__images__openai_image")).toEqual({ label: "OpenAI · make image", maker: "openai" });
    expect(toolLabel("mcp__images__claude_graphic")).toEqual({ label: "Claude · draw graphic", maker: "claude" });
    expect(toolLabel("mcp__images__choose_maker")).toEqual({ label: "Ask · who makes it", maker: null });
    expect(toolLabel("mcp__images__save_to_brand")).toEqual({ label: "Brand folder · save", maker: null });
    expect(toolLabel("Bash")).toEqual({ label: "Bash", maker: null });
    expect(toolLabel("mcp__gmail__gmail_search")).toEqual({ label: "mcp__gmail__gmail_search", maker: null });
    // The step is titled with the image's name, else its brief; other tools keep their own title.
    expect(imageStepTitle("mcp__images__openai_image", { prompt: "Square post, pastel", name: "Spring sale post" })).toBe("Spring sale post");
    expect(imageStepTitle("mcp__images__openai_image", { prompt: "Square post, pastel" })).toBe("Square post, pastel");
    expect(imageStepTitle("mcp__images__choose_maker", { request: "a sale graphic" })).toBe("a sale graphic");
    expect(imageStepTitle("Bash", { command: "ls" })).toBeNull();
  });

  it("knows when OpenAI is at work in a live run, and when it has finished or failed", () => {
    const started = { kind: "system", data: { message: "OpenAI is making “Spring sale post”. Nothing in your message said otherwise.", imageRoute: { action: "proceed", maker: "openai", why: "x" } } };
    const done = { kind: "system", data: { message: "OpenAI made it", imageCard: card() } };
    const failed = { kind: "system", data: { message: "OpenAI: plan limit reached", imageIssue: { maker: "openai" } } };
    expect(liveImageWork([{ kind: "text", data: { text: "On it." } }, started])).toEqual({ maker: "openai", text: "OpenAI is making “Spring sale post”" });
    expect(liveImageWork([started, done])).toBeNull();
    expect(liveImageWork([started, failed])).toBeNull();
    expect(liveImageWork([started, done, started])).not.toBeNull();
    expect(liveImageWork([{ kind: "system", data: { message: "Image sent to Claude instead.", imageRoute: { action: "redirect", maker: "claude" } } }])).toBeNull();
    expect(liveImageWork(undefined)).toBeNull();
  });
});

describe("one-tap questions", () => {
  const approval = (over: Record<string, unknown> = {}) => ({ kind: "question" as const, status: "pending" as const, risk: "low" as const, questions: [makerQuestion(false)], ...over });

  it("one question with a few choices is answered on its card", () => {
    const q = quickQuestion(approval())!;
    expect(q.options.map((o) => o.label)).toEqual(["OpenAI image", "Claude overlay / SVG"]);
    expect(quickAnswer(q, "OpenAI image")).toEqual({ [MAKER_QUESTION]: "OpenAI image" });
    expect(quickQuestion(approval({ questions: [makerQuestion(true)] }))!.options).toHaveLength(3);
  });

  it("anything more involved opens the full screen: several questions, pick-many, high risk, or not a question", () => {
    const q = makerQuestion(false);
    expect(quickQuestion(approval({ questions: [q, { ...q, question: "And where?" }] }))).toBeNull();
    expect(quickQuestion(approval({ questions: [{ ...q, multiSelect: true }] }))).toBeNull();
    expect(quickQuestion(approval({ risk: "high" }))).toBeNull();
    expect(quickQuestion(approval({ kind: "tool" }))).toBeNull();
    expect(quickQuestion(approval({ status: "approved" }))).toBeNull();
    expect(quickQuestion(approval({ questions: null }))).toBeNull();
  });
});
