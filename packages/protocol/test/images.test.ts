import { describe, expect, it } from "vitest";
import {
  AgentImagesStatus, GeneratedImageCard, IMAGE_ACTIONS, IMAGE_TOOL, ImageIssueCard, MAKER_CHOICES, MAKER_QUESTION, MUTATIONS, Message, choiceFromLabel, decideImageRoute,
  imageSignals, imageToolId, isArtifactId, isImageTool, makerQuestion, newId, planUsageText, previewIdOf, resolveImageRoute, toolMaker, type RouteInput,
} from "../src";

const route = (ownerText: string, called: "openai" | "claude", over: Partial<RouteInput> = {}) => decideImageRoute({ setting: "auto", ownerText, called, ...over });

describe("reading the owner's words", () => {
  it("hears a rendered picture", () => {
    for (const t of ["a photo of our storefront at dusk", "make a realistic product shot of the mug", "an illustration of a fox reading", "generate an image of a lighthouse"]) {
      const s = imageSignals(t);
      expect(s.picture.length, t).toBeGreaterThan(0);
      expect(s.vector, t).toEqual([]);
    }
  });

  it("hears text, overlay and vector work", () => {
    for (const t of ["make an SVG badge that says 20% off", "a lower third with my name", "a text overlay for the reel", "a vector icon of a wrench", "title card for the video", "transparent watermark"]) {
      const s = imageSignals(t);
      expect(s.vector.length, t).toBeGreaterThan(0);
      expect(s.picture, t).toEqual([]);
    }
  });

  it("hears a maker named outright, and does not mistake a greeting for one", () => {
    expect(imageSignals("use GPT image for this one").explicit).toBe("openai");
    expect(imageSignals("generate it with OpenAI").explicit).toBe("openai");
    expect(imageSignals("make it with ChatGPT").explicit).toBe("openai");
    expect(imageSignals("have Claude draw this one").explicit).toBe("claude");
    expect(imageSignals("make it again with Claude as an SVG").explicit).toBe("claude");
    expect(imageSignals("OpenAI for the photo, then let Claude do the text").explicit).toBe("both");
    // "Claude, ..." is how the owner talks to the agent.
    expect(imageSignals("Claude, I need a graphic for the spring sale").explicit).toBeNull();
    expect(imageSignals("a graphic for the spring sale").explicit).toBeNull();
  });

  it("does not take a picture that already exists for a request to make one", () => {
    expect(imageSignals("add a text overlay to that picture")).toMatchObject({ picture: [], vector: ["text overlay"] });
    expect(imageSignals("put our tagline on the last photo as a caption bar")).toMatchObject({ picture: [] });
    expect(imageSignals("a photo of the shop with a text overlay").picture).toEqual(["photo"]);
    // The words quoted back are the owner's own.
    expect(imageSignals("an SVG Lower Third for our reels").vector).toEqual(["svg", "lower third"]);
  });

  it("says nothing about a plain request", () => {
    expect(imageSignals("make a social media graphic with this company logo for the spring sale")).toEqual({ explicit: null, picture: [], vector: [] });
    // Naming something to build on, or a file, is not a request for a vector graphic.
    for (const t of [
      "Generate a social media graphic for our spring sale. Headline: Spring Sale, 20% off everything. Use our wordmark from brand/wordmark.png in a corner.",
      "a launch post with our logo (brand/logo.svg) and a thin border", "an Instagram post with our badge in the corner and the new template colours",
    ]) expect(imageSignals(t), t).toEqual({ explicit: null, picture: [], vector: [] });
  });
});

describe("who makes the image", () => {
  it("a plain request goes to OpenAI without a question: pictures are the default", () => {
    expect(route("generate a social media graphic with this company logo", "openai")).toMatchObject({ action: "proceed", maker: "openai", basis: "default" });
    expect(route("Generate a social media graphic for our spring sale. Use our wordmark from brand/wordmark.png in a corner.", "openai")).toMatchObject({ action: "proceed", basis: "default" });
  });

  it("a request that is clearly a picture goes to OpenAI; clearly a graphic, to Claude", () => {
    expect(route("a photo of the bakery counter in morning light", "openai")).toMatchObject({ action: "proceed", basis: "clear" });
    expect(route("make an SVG lower third with my name and title", "claude")).toMatchObject({ action: "proceed", maker: "claude", basis: "clear" });
  });

  it("asks when the words point both ways, and offers both", () => {
    const d = route("a photo of the shop with a text overlay saying 20% off", "openai");
    expect(d).toMatchObject({ action: "ask", basis: "mixed", offerBoth: true });
    expect(route("a photo of the shop with a text overlay saying 20% off", "claude")).toMatchObject({ action: "ask", basis: "mixed" });
  });

  it("asks when the agent goes against what the words say", () => {
    expect(route("a photo of the bakery counter", "claude")).toMatchObject({ action: "ask", basis: "disagree", offerBoth: false });
    expect(route("an SVG icon set for the menu", "openai")).toMatchObject({ action: "ask", basis: "disagree" });
  });

  it("asks when the agent wants to draw something the owner did not describe as a graphic", () => {
    expect(route("make something for the spring sale", "claude")).toMatchObject({ action: "ask", basis: "unclear" });
    // ...unless the session is already working on one of Claude's graphics.
    expect(route("make the headline bolder", "claude", { lastMaker: "claude" })).toMatchObject({ action: "proceed", basis: "continue" });
  });

  it("a maker named in the message wins, over the agent and over the session's setting", () => {
    expect(route("use GPT image for the badge", "claude")).toMatchObject({ action: "redirect", maker: "openai", basis: "explicit" });
    expect(route("have Claude draw the storefront photo idea as an SVG", "openai")).toMatchObject({ action: "redirect", maker: "claude", basis: "explicit" });
    expect(route("make it with OpenAI", "openai", { setting: "claude" })).toMatchObject({ action: "proceed", basis: "explicit" });
    expect(route("OpenAI for the photo, then let Claude do the text", "claude")).toMatchObject({ action: "proceed", basis: "explicit" });
  });

  it("a session set to one maker sends everything there", () => {
    expect(route("a badge", "openai", { setting: "openai" })).toMatchObject({ action: "proceed", basis: "setting" });
    expect(route("a badge", "claude", { setting: "openai" })).toMatchObject({ action: "redirect", maker: "openai", basis: "setting" });
    expect(route("a photo of a dog", "openai", { setting: "claude" })).toMatchObject({ action: "redirect", maker: "claude", basis: "setting" });
  });

  it("a session set to ask always asks, until the owner has answered in that run", () => {
    expect(route("a photo of a dog", "openai", { setting: "ask" })).toMatchObject({ action: "ask", basis: "setting" });
    expect(route("a photo of a dog", "openai", { setting: "ask", answered: "openai" })).toMatchObject({ action: "proceed", basis: "answer" });
  });

  it("the owner's answer holds for the rest of the run", () => {
    const mixed = "a photo of the shop with a text overlay";
    expect(route(mixed, "openai", { answered: "openai" })).toMatchObject({ action: "proceed", basis: "answer" });
    expect(route(mixed, "claude", { answered: "openai" })).toMatchObject({ action: "redirect", maker: "openai", basis: "answer" });
    expect(route(mixed, "openai", { answered: "both" })).toMatchObject({ action: "proceed" });
    expect(route(mixed, "claude", { answered: "both" })).toMatchObject({ action: "proceed" });
  });

  it("the buttons on an image card name the maker, so they never lead to a question", () => {
    const openai = { maker: "openai" as const, name: "Spring sale post" };
    const claude = { maker: "claude" as const, name: "Sale badge" };
    expect(route(IMAGE_ACTIONS.regenerate(openai), "openai")).toMatchObject({ action: "proceed", basis: "explicit" });
    expect(route(IMAGE_ACTIONS.regenerate(claude), "claude")).toMatchObject({ action: "proceed", basis: "explicit" });
    expect(route(IMAGE_ACTIONS.switchMaker(openai), "claude")).toMatchObject({ action: "proceed", basis: "explicit" });
    expect(route(IMAGE_ACTIONS.switchMaker(claude), "openai")).toMatchObject({ action: "proceed", basis: "explicit" });
    expect(route(IMAGE_ACTIONS.switchMaker(openai), "openai")).toMatchObject({ action: "redirect", maker: "claude" });
  });
});

describe("the one-tap question", () => {
  it("has two answers, or three when both makes sense, and reads them back", () => {
    expect(makerQuestion(false)).toMatchObject({ question: MAKER_QUESTION, multiSelect: false });
    expect(makerQuestion(false).options.map((o) => o.label)).toEqual(["OpenAI image", "Claude overlay / SVG"]);
    expect(makerQuestion(true).options.map((o) => o.label)).toEqual(["OpenAI image", "Claude overlay / SVG", "Both"]);
    expect(choiceFromLabel("OpenAI image")).toBe("openai");
    expect(choiceFromLabel(" claude overlay / svg ")).toBe("claude");
    expect(choiceFromLabel(MAKER_CHOICES.both.label)).toBe("both");
    expect(choiceFromLabel("something else")).toBeNull();
    expect(choiceFromLabel(undefined)).toBeNull();
  });
});

describe("settings, tools and cards", () => {
  it("a session follows its own setting, then its project's, then Auto", () => {
    expect(resolveImageRoute({ imageRoute: "ask" }, { imageRoute: "openai" })).toEqual({ route: "ask", from: "session" });
    expect(resolveImageRoute({ imageRoute: null }, { imageRoute: "openai" })).toEqual({ route: "openai", from: "project" });
    expect(resolveImageRoute({}, null)).toEqual({ route: "auto", from: "default" });
    expect(resolveImageRoute(null, { imageRoute: "nonsense" as any })).toEqual({ route: "auto", from: "default" });
  });

  it("the provider of a tool call comes from the tool's own name", () => {
    expect(toolMaker(imageToolId(IMAGE_TOOL.openai))).toBe("openai");
    expect(toolMaker("mcp__images__claude_graphic")).toBe("claude");
    expect(toolMaker(imageToolId(IMAGE_TOOL.ask))).toBeNull();
    expect(toolMaker("Bash")).toBeNull();
    expect(toolMaker("mcp__gmail__openai_image")).toBeNull();
    expect(isImageTool("mcp__images__choose_maker")).toBe(true);
    expect(isImageTool("mcp__gmail__gmail_search")).toBe(false);
  });

  it("artifact ids are ids, with a preview form", () => {
    const id = newId("art");
    expect(isArtifactId(id)).toBe(true);
    expect(isArtifactId(previewIdOf(id))).toBe(true);
    expect(isArtifactId("art_../../etc/passwd")).toBe(false);
    expect(isArtifactId(newId("msg"))).toBe(false);
  });

  it("an image card and an issue card ride on a message", () => {
    const card = {
      type: "generated_image", artifactId: newId("art"), previewId: null, maker: "openai", via: "ChatGPT plan · via Codex CLI", model: null, name: "Spring sale post",
      prompt: "Square post, headline 'Spring sale'", mime: "image/png", width: 1254, height: 1254, bytes: 1_160_621, seconds: 31, savedPath: "assets/generated/2026-11-22-spring-sale-post.png",
      references: ["brand/logo.png"], routedWhy: "Nothing in your message said otherwise.", base: null, stored: true,
    };
    expect(GeneratedImageCard.safeParse(card).success).toBe(true);
    expect(GeneratedImageCard.safeParse({ ...card, maker: "midjourney" }).success).toBe(false);
    const issue = { type: "image_issue", maker: "openai", reason: "not_ready", title: "not connected", message: "Codex is not signed in on homebase-server. Run `codex login` there.", hint: null };
    expect(ImageIssueCard.safeParse(issue).success).toBe(true);
    for (const c of [card, issue]) {
      expect(Message.safeParse({ id: newId("msg"), threadId: newId("thr"), role: "assistant", text: "x", source: "agent", runId: null, authorDeviceId: null, createdAt: 1, card: c }).success).toBe(true);
    }
  });

  it("images.set takes a session or a project and a route, or null to follow the level above", () => {
    expect(MUTATIONS["images.set"].safeParse({ scope: "thread", id: "thr_1", route: "ask" }).success).toBe(true);
    expect(MUTATIONS["images.set"].safeParse({ scope: "project", id: "prj_1", route: null }).success).toBe(true);
    expect(MUTATIONS["images.set"].safeParse({ scope: "thread", id: "thr_1", route: "gemini" }).success).toBe(false);
  });

  it("plan usage reads as one line, and says nothing when nothing is known", () => {
    const base = AgentImagesStatus.parse({
      openai: { ready: true, cliVersion: "0.144.5", signedIn: true, method: "chatgpt", note: null, plan: "plus", usedPercent: 4, windowMins: 10080, resetsAt: Date.UTC(2026, 10, 26, 18, 14), imagesLastHour: 3, capPerHour: 20, capPerRun: 4, checkedAt: 1 },
      claude: { canRender: true }, saveDir: "assets/generated", brandDir: "brand",
    }).openai;
    expect(planUsageText(base)).toMatch(/^ChatGPT Plus · 4% of this week used · resets \w{3} /);
    expect(planUsageText({ ...base, usedPercent: null })).toBe("ChatGPT Plus");
    expect(planUsageText({ ...base, usedPercent: null, plan: null })).toBeNull();
    expect(planUsageText({ ...base, windowMins: 300, resetsAt: null })).toBe("ChatGPT Plus · 4% of this 5 h window used");
  });
});
