import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  IMAGES_MCP_SERVER, IMAGE_TOOL, MAKER_CHOICES, MAKER_LABEL, MAKER_QUESTION, MAKER_VIA, ROUTE_TITLE, choiceFromLabel, decideImageRoute, imageSignals, imageToolId,
  makerQuestion, type GeneratedImageCard, type ImageIssueCard, type ImageMaker, type ImageRoute, type MakerChoice, type PermissionMode, type RunEventKind,
} from "@homebase/protocol";
import type { ApprovalDecision, ApprovalDraft } from "../adapters/types";
import type { CodexClient } from "./codex";
import { BRAND_DIR, mimeOf, nameFromPrompt, shownPath, type ImageStore } from "./store";
import { checkSvg, imageSize, type SvgRenderer } from "./svg";

/**
 * The image tools one run of a Claude agent gets (docs/MULTI-PROVIDER-PLAN.md 3). Claude leads the
 * session and picks a tool; this class decides whether that pick goes ahead, is sent to the other maker,
 * or is put to the owner as a one-tap question, then makes the image and says who made it.
 *
 *   openai_image    OpenAI's image model, through the Codex CLI on the owner's ChatGPT plan
 *   claude_graphic  an SVG the agent drew itself, optionally put on top of another picture
 *   choose_maker    the agent asks the owner which of the two it should be
 *   save_to_brand   copies a finished image into the working directory's brand folder
 *
 * The card the owner sees is built here from what actually happened. Nothing the model says can change
 * the maker on it.
 */

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface OpenAiReadiness {
  ready: boolean;
  /** Why not, with the command that fixes it. */
  note: string | null;
}

export interface StudioRunContext {
  runId: string;
  threadId: string | null;
  cwd: string;
  /** The setting in force for this run, from the hub. */
  route: ImageRoute;
  /** Tell Claude to look at each finished image and compare it with the brief. */
  check: boolean;
  /** The owner's latest message in this run. */
  ownerText(): string;
  /** The run's permission mode, shown on the question card. */
  mode(): PermissionMode;
  /** The Claude model drawing the graphics, as a label ("Opus 5.5"). */
  claudeModel(): string | null;
  requestApproval(draft: ApprovalDraft): Promise<ApprovalDecision>;
  emit(kind: RunEventKind, data: Record<string, unknown>): void;
  signal: AbortSignal;
  /**
   * Puts a message into the run as the owner's next message, after the agent's current turn. Used for a
   * decision the owner made in the app (a tapped answer, the session's setting), in the words of that choice.
   * Returns false when the run cannot take one.
   */
  tellAgent?(text: string): boolean;
}

export interface StudioDeps {
  codex: CodexClient;
  store: ImageStore;
  /** Null when this machine cannot turn SVGs into pixels. */
  renderer(): Promise<SvgRenderer | null>;
  /** Is OpenAI usable right now. Re-checked by the studio when its last answer is stale. */
  openaiReady(): Promise<OpenAiReadiness>;
  /** Called after each OpenAI attempt, so the plan's usage numbers are read again. */
  afterOpenAi(): void;
  caps: { perRun: number; perHour: number };
  /** The maker of the session's last image, kept by the studio across runs. */
  lastMaker(threadId: string | null): ImageMaker | null;
  setLastMaker(threadId: string | null, maker: ImageMaker): void;
  /** Who made a file that is used as the base of an overlay, when the studio knows. */
  madeBy(file: string): { maker: ImageMaker; name: string } | null;
  remember(file: string, made: { maker: ImageMaker; name: string }): void;
  now(): number;
}

/**
 * How an owner's decision made in the app reaches the agent.
 *
 * The agent never sees the tap. Tested with the real CLI: told in a tool result that "the owner chose Both",
 * it declined to act ("that came through the tool, not from you"), and it is right to be wary of
 * instructions in tool output. So a decision that changes the plan is not put in the tool result at all. The
 * tool says only that the owner's answer is on its way, and the answer is delivered as the owner's next
 * message in the conversation (`tellAgent`), in the words of the choice they tapped. When that channel is
 * not there, the result carries the answer itself and says where it came from.
 */
const OWNER_ANSWER = "The owner answered HomeBase's question in the app just now, with one tap:";
const WAIT_FOR_OWNER =
  "Nothing was made. HomeBase asked the owner in the app who should make this image, and they have answered. Their answer arrives as their next message in this conversation. " +
  "End this turn now: reply with only “One moment.” and make nothing until that message arrives.";
const WAIT_FOR_SETTING =
  "Nothing was made. The owner has set in the HomeBase app who makes images in this session, and that is not this tool. What they set arrives as their next message in this conversation. " +
  "End this turn now: reply with only “One moment.” and make nothing until that message arrives.";
/** The words that stand for the owner's tap or setting. Each is the choice's own label and what it means, nothing more. */
const SAID = {
  openai: "(Tapped in HomeBase) OpenAI image: have OpenAI make this one as a rendered picture.",
  claude: "(Tapped in HomeBase) Claude overlay / SVG: make this one yourself, as an SVG graphic.",
  both: "(Tapped in HomeBase) Both: have OpenAI make the picture with no text or lettering in it, then put the words on top yourself as an SVG overlay on that picture.",
  setOpenai: "(Set in HomeBase for this session) Images here are always made by OpenAI: have OpenAI make this one as a rendered picture.",
  setClaude: "(Set in HomeBase for this session) Graphics here are always made by you: make this one yourself, as an SVG graphic.",
} as const;
/** The routing rule's reasons are worded for the owner ("You chose…", "Your message…"); the agent reads them in the third person. */
const forAgent = (why: string) => why.replace(/^You chose\b/, "The owner chose").replace(/^Your message\b/, "The owner's message").replace(/\byour message\b/g, "the owner's message");

/** In the tool descriptions, so the agent knows beforehand what happens when the owner is asked. */
const OWNER_ANSWER_NOTE =
  "Before anything is made, HomeBase may show the owner a one-tap question in the app: OpenAI image, Claude overlay / SVG, or Both. " +
  "When their answer changes the plan, this tool returns without making anything and the owner's answer arrives as their next message: end your turn and wait for it, then do what it says.";

/** The fallback when the answer cannot be delivered as a message: both steps, spelled out, with where the answer came from. */
const BOTH_PLAN =
  `${OWNER_ANSWER} Both: OpenAI makes the picture and you put the words on top. Nothing has been made yet. Do it in two steps. ` +
  `1) Call ${IMAGE_TOOL.openai} with a brief for the picture only: no text, lettering or logos in it, and calm space where the words will go. ` +
  `2) Draw the words or overlay as an SVG with no background and the same aspect ratio, and call ${IMAGE_TOOL.claude} with base_image set to the file step 1 returned.`;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const fail = (text: string): ToolResult => ({ text, isError: true });

export class StudioRun {
  /** The owner's answer to "who should make this", for the rest of the run. */
  private answered: MakerChoice | null = null;
  private openaiCalls = 0;
  private briefs = new Set<string>();
  /** The session's standing choice has been said to the agent in this run. */
  private toldSetting = false;

  constructor(private c: StudioRunContext, private d: StudioDeps) {}

  call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case IMAGE_TOOL.openai: return this.openaiImage(args);
      case IMAGE_TOOL.claude: return this.claudeGraphic(args);
      case IMAGE_TOOL.ask: return this.chooseMaker(args);
      case IMAGE_TOOL.brand: return Promise.resolve(this.saveToBrand(args));
      default: return Promise.resolve(fail(`There is no image tool called ${name.slice(0, 60)}.`));
    }
  }

  // ---------------------------------------------------------------- routing

  private toolFor(maker: ImageMaker) {
    return maker === "openai" ? IMAGE_TOOL.openai : IMAGE_TOOL.claude;
  }

  /** Delivers the owner's decision as their next message. False when this run has no such channel. */
  private say(text: string): boolean {
    if (!this.c.tellAgent?.(text)) return false;
    this.c.emit("system", { message: `Told the agent for you: “${text}”`, imageRoute: { action: "told" } });
    return true;
  }

  /** The agent called one maker's tool and the job belongs to the other. `said`: the owner's decision in words, when it was made in the app. */
  private redirect(to: ImageMaker, why: string, said?: { text: string; wait: string }): ToolResult {
    this.c.emit("system", { message: `Image sent to ${MAKER_LABEL[to]} instead. ${why}`, imageRoute: { action: "redirect", maker: to, why } });
    if (said && this.say(said.text)) return { text: said.wait };
    // An ordinary result, not an error: nothing went wrong, the job simply belongs to the other maker.
    return {
      text: to === "claude"
        ? `Nothing was sent to OpenAI. ${forAgent(why)} So this one is yours: draw it as an SVG and store it with ${IMAGE_TOOL.claude}. Do not call ${IMAGE_TOOL.openai} for this request.`
        : `Nothing was stored. ${forAgent(why)} So this one goes to OpenAI: call ${IMAGE_TOOL.openai} with a full brief. Do not draw it yourself.`,
    };
  }

  /** Puts the one-tap question to the owner. Null when they dismissed it or the run ended. */
  private async ask(suggested: ImageMaker | null, brief: string, why: string, offerBoth: boolean): Promise<MakerChoice | null> {
    let decision: ApprovalDecision;
    try {
      decision = await this.c.requestApproval({
        kind: "question", tool: imageToolId(suggested ? this.toolFor(suggested) : IMAGE_TOOL.ask), title: MAKER_QUESTION, summary: brief.slice(0, 300),
        input: { imageChoice: true, brief: brief.slice(0, 2000), suggested, why }, questions: [makerQuestion(offerBoth)], risk: "low", reason: why, mode: this.c.mode(),
      });
    } catch {
      return null;
    }
    if (decision.decision !== "approve") return null;
    const choice = choiceFromLabel(decision.answers?.[MAKER_QUESTION] ?? Object.values(decision.answers ?? {})[0]);
    if (choice) {
      this.answered = choice;
      this.c.emit("system", { message: `You chose ${MAKER_CHOICES[choice].label} for this image.`, imageRoute: { action: "answer", choice } });
    }
    return choice;
  }

  /** Applies the routing rule to a tool the agent called. Returns what to tell the agent when the call does not go ahead. */
  private async gate(called: ImageMaker, brief: string, hasBase = false): Promise<{ stop: ToolResult } | { why: string }> {
    const d = decideImageRoute({ setting: this.c.route, ownerText: this.c.ownerText(), called, answered: this.answered, lastMaker: this.d.lastMaker(this.c.threadId) });
    if (d.action === "proceed") return { why: d.why };
    if (d.action === "redirect") {
      // A session set to one maker is the owner's decision made in the app: it is said to the agent once per run, as their message.
      // A maker named in the owner's own message, or an answer already delivered, needs no such thing: the agent can see it.
      const said = d.basis === "setting" && !this.toldSetting ? { text: d.maker === "openai" ? SAID.setOpenai : SAID.setClaude, wait: WAIT_FOR_SETTING } : undefined;
      if (said) this.toldSetting = true;
      return { stop: this.redirect(d.maker, d.why, said) };
    }
    const choice = await this.ask(called, brief, d.why, d.offerBoth);
    if (this.c.signal.aborted) return { stop: fail("The run was cancelled before the owner answered.") };
    if (!choice) return { stop: fail("The owner dismissed the question in the HomeBase app, so no image was made. Do not make it another way; ask them what they would like.") };
    if (choice === "both") {
      // The brief in hand was written for one maker doing everything. Nothing has been made yet, so the agent is
      // sent back to split the job: the picture without the words, then the words on top.
      if (called === "claude" && hasBase) return { why: "You chose Both." };
      return { stop: { text: this.say(SAID.both) ? WAIT_FOR_OWNER : BOTH_PLAN } };
    }
    if (choice === called) return { why: `You chose ${MAKER_CHOICES[choice].label}.` };
    return { stop: this.redirect(choice, `${OWNER_ANSWER} ${MAKER_CHOICES[choice].label}.`, { text: SAID[choice], wait: WAIT_FOR_OWNER }) };
  }

  private issue(card: Omit<ImageIssueCard, "type">) {
    this.c.emit("system", { message: `${MAKER_LABEL[card.maker]}: ${card.title}`, imageIssue: { type: "image_issue", ...card } });
  }

  // ---------------------------------------------------------------- OpenAI

  async openaiImage(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = str(args.prompt, 6000);
    if (prompt.length < 8) return fail("prompt is required: a full image brief (subject, exact text in quotes, style, colours, aspect ratio).");
    const name = str(args.name, 80) || nameFromPrompt(prompt);
    const refsIn = Array.isArray(args.reference_images) ? args.reference_images.slice(0, 4) : [];
    const references: string[] = [];
    for (const r of refsIn) {
      const hit = this.d.store.resolveReference(r, this.c.cwd, this.c.threadId);
      if (!hit.ok) return fail(`No image was made. ${hit.reason}`);
      references.push(hit.path);
    }

    const gate = await this.gate("openai", prompt);
    if ("stop" in gate) return gate.stop;

    const base = { at: this.d.now(), maker: "openai" as const, runId: this.c.runId, threadId: this.c.threadId, name };
    const ready = await this.d.openaiReady();
    if (!ready.ready) {
      const note = ready.note ?? "OpenAI images are not set up on this machine.";
      this.issue({ maker: "openai", reason: "not_ready", title: "not connected", message: note, hint: null });
      this.d.store.record({ ...base, ok: false, reason: "not_ready" });
      return fail(`OpenAI could not make the image: ${note} Tell the owner exactly that. Do not draw a substitute yourself unless they ask for one.`);
    }
    if (this.openaiCalls >= this.d.caps.perRun) {
      const message = `This reply has already asked OpenAI for ${this.d.caps.perRun} images, which is HomeBase's limit for one reply. Ask again in a new message for more.`;
      this.issue({ maker: "openai", reason: "limit", title: "limit for one reply reached", message, hint: null });
      this.d.store.record({ ...base, ok: false, reason: "cap" });
      return fail(`No image was made. ${message} Tell the owner; do not try again in this reply.`);
    }
    const lastHour = this.d.store.countLastHour("openai");
    if (lastHour >= this.d.caps.perHour) {
      const message = `${lastHour} OpenAI images were asked for in the last hour, which is HomeBase's hourly limit (${this.d.caps.perHour}). It frees up as the hour moves on.`;
      this.issue({ maker: "openai", reason: "limit", title: "hourly limit reached", message, hint: null });
      this.d.store.record({ ...base, ok: false, reason: "cap" });
      return fail(`No image was made. ${message} Tell the owner; do not try again.`);
    }
    const key = `${prompt}\u0000${references.join("|")}`;
    if (this.briefs.has(key)) return fail("OpenAI was already asked for exactly this image in this reply. One attempt per image: tell the owner how it went instead of asking again.");
    this.briefs.add(key);
    this.openaiCalls++;

    this.c.emit("system", { message: `OpenAI is making “${name}”. ${gate.why}`, imageRoute: { action: "proceed", maker: "openai", why: gate.why } });
    const r = await this.d.codex.image({ prompt, references, cwd: this.c.cwd, signal: this.c.signal });
    this.d.afterOpenAi();
    if (!r.ok) {
      this.d.store.record({ ...base, ok: false, seconds: r.seconds, reason: r.reason });
      if (r.reason === "cancelled") return fail("The run was cancelled.");
      const title = r.reason === "limit" ? "plan limit reached" : r.reason === "refused" ? "declined to make this image" : r.reason === "timeout" ? "took too long" : "returned no image";
      this.issue({ maker: "openai", reason: r.reason === "limit" ? "limit" : r.reason === "refused" ? "refused" : "failed", title, message: r.message, hint: r.reason === "limit" ? "Nothing was switched to another provider. Try again after the plan resets." : null });
      return fail(`OpenAI ${title}: ${r.message} Tell the owner what OpenAI said. Do not retry and do not draw a substitute yourself unless they ask.`);
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(r.file);
    } catch (err) {
      this.d.store.record({ ...base, ok: false, seconds: r.seconds, reason: "failed" });
      this.issue({ maker: "openai", reason: "failed", title: "returned no image", message: `The file Codex saved could not be read: ${(err as Error).message}`.slice(0, 500), hint: null });
      return fail("OpenAI's image file could not be read. Tell the owner; do not retry.");
    }
    const size = imageSize(bytes);
    const ext = (size?.mime === "image/jpeg" ? ".jpg" : size?.mime === "image/webp" ? ".webp" : ".png") as ".png" | ".jpg" | ".webp";
    const saved = await this.d.store.save({
      threadId: this.c.threadId, cwd: this.c.cwd, name, ext, bytes,
      meta: { maker: "openai", via: MAKER_VIA.openai, name, prompt, references: references.map((p) => shownPath(p, this.c.cwd)), seconds: r.seconds, runId: this.c.runId, codexThread: r.threadId },
    });
    const card: GeneratedImageCard = {
      type: "generated_image", artifactId: saved.id, previewId: null, maker: "openai", via: MAKER_VIA.openai, model: null, name, prompt,
      mime: size?.mime ?? mimeOf(saved.artifactPath), width: size?.width ?? null, height: size?.height ?? null, bytes: bytes.length, seconds: r.seconds,
      savedPath: saved.savedPath ? shownPath(saved.savedPath, this.c.cwd) : null, references: references.map((p) => shownPath(p, this.c.cwd)).slice(0, 8),
      routedWhy: gate.why.slice(0, 300), base: null, stored: saved.stored,
    };
    this.c.emit("system", { message: `OpenAI made “${name}” in ${Math.round(r.seconds)} s`, imageCard: card });
    this.d.store.record({ ...base, ok: true, seconds: r.seconds });
    this.d.setLastMaker(this.c.threadId, "openai");
    const file = saved.savedPath ?? saved.artifactPath;
    this.d.remember(file, { maker: "openai", name });
    return {
      text: [
        `OpenAI made the image “${name}”. The owner sees it in the session as a card marked OpenAI, so do not describe it as your own work and do not paste the path as a link.`,
        `File: ${file}`,
        this.answered === "both"
          ? `The owner chose Both, and this is step 1. Step 2 now: draw the words or overlay as an SVG with no background and the same aspect ratio, and call ${IMAGE_TOOL.claude} with base_image set to that file. Do not tell the owner it is ready before that.`
          : this.c.check
          ? "The owner wants each image checked: Read that file now, compare it with the brief (exact wording and spelling of any text, the logo or reference intact, the layout asked for) and tell the owner in a sentence or two what is right and what is off. Do not make another image on your own."
          : "Say in one short sentence that it is ready. Do not call this tool again for the same request unless the owner asks.",
      ].filter(Boolean).join("\n"),
    };
  }

  // ---------------------------------------------------------------- Claude

  async claudeGraphic(args: Record<string, unknown>): Promise<ToolResult> {
    const checked = checkSvg(args.svg);
    if (!checked.ok) return fail(`The graphic was not stored. ${checked.reason}`);
    const name = str(args.name, 80) || "Graphic";
    const description = str(args.description, 600) || name;
    let basePath: string | null = null;
    if (args.base_image != null && args.base_image !== "") {
      const hit = this.d.store.resolveReference(args.base_image, this.c.cwd, this.c.threadId);
      if (!hit.ok) return fail(`The graphic was not stored. base_image: ${hit.reason}`);
      basePath = hit.path;
    }

    const gate = await this.gate("claude", description, !!basePath);
    if ("stop" in gate) return gate.stop;

    const renderer = await this.d.renderer();
    const model = this.c.claudeModel();
    const meta = { maker: "claude", via: MAKER_VIA.claude, model, name, prompt: description, runId: this.c.runId };
    let card: GeneratedImageCard;
    let file: string;
    try {
      if (basePath) {
        if (!renderer) return fail("This machine cannot put a graphic on top of a picture (it has no image library). Store the SVG without base_image and tell the owner the overlay is a separate file.");
        const over = await renderer.overlay(readFileSync(basePath), checked.svg);
        const made = this.d.madeBy(basePath);
        const baseShown = shownPath(basePath, this.c.cwd);
        const saved = await this.d.store.save({
          threadId: this.c.threadId, cwd: this.c.cwd, name, ext: ".png", bytes: over.png, source: { ext: ".svg", bytes: Buffer.from(checked.svg, "utf8") },
          meta: { ...meta, base: baseShown, baseMaker: made?.maker ?? null },
        });
        file = saved.savedPath ?? saved.artifactPath;
        card = {
          type: "generated_image", artifactId: saved.id, previewId: null, maker: "claude", via: "Claude plan · SVG overlay", model, name, prompt: description,
          mime: "image/png", width: over.width, height: over.height, bytes: over.png.length, seconds: null,
          savedPath: saved.savedPath ? shownPath(saved.savedPath, this.c.cwd) : null, references: [baseShown], routedWhy: gate.why.slice(0, 300),
          base: made ? { maker: made.maker, name: made.name.slice(0, 120) } : null, stored: saved.stored,
        };
      } else {
        const preview = renderer ? await renderer.png(checked.svg, { width: checked.width!, height: checked.height! }).catch(() => null) : null;
        const bytes = Buffer.from(checked.svg, "utf8");
        const saved = await this.d.store.save({ threadId: this.c.threadId, cwd: this.c.cwd, name, ext: ".svg", bytes, preview, meta });
        file = saved.savedPath ?? saved.artifactPath;
        card = {
          type: "generated_image", artifactId: saved.id, previewId: saved.previewId, maker: "claude", via: MAKER_VIA.claude, model, name, prompt: description,
          mime: "image/svg+xml", width: checked.width, height: checked.height, bytes: bytes.length, seconds: null,
          savedPath: saved.savedPath ? shownPath(saved.savedPath, this.c.cwd) : null, references: [], routedWhy: gate.why.slice(0, 300), base: null, stored: saved.stored,
        };
      }
    } catch (err) {
      this.issue({ maker: "claude", reason: "failed", title: "the graphic could not be stored", message: (err as Error).message.slice(0, 500), hint: null });
      return fail(`The graphic was not stored: ${(err as Error).message.slice(0, 300)}`);
    }
    this.c.emit("system", { message: `Claude drew “${name}”${card.base ? ` on an image by ${MAKER_LABEL[card.base.maker]}` : ""}`, imageCard: card });
    this.d.store.record({ at: this.d.now(), maker: "claude", ok: true, runId: this.c.runId, threadId: this.c.threadId, name });
    this.d.setLastMaker(this.c.threadId, "claude");
    this.d.remember(file, { maker: "claude", name });
    return { text: `Stored “${name}”. The owner sees it in the session as a card marked Claude. File: ${file}\nSay in one short sentence that it is ready; do not paste the SVG or the path as a link.` };
  }

  // ---------------------------------------------------------------- asking, and the brand folder

  async chooseMaker(args: Record<string, unknown>): Promise<ToolResult> {
    const request = str(args.request, 600) || "an image";
    /** What to do for a choice, without saying where the choice came from. */
    const todo = (choice: MakerChoice) =>
      choice === "openai" ? `Call ${IMAGE_TOOL.openai} with a full brief.`
        : choice === "claude" ? `Draw it as an SVG and call ${IMAGE_TOOL.claude}.`
        : `Call ${IMAGE_TOOL.openai} for the picture only (no text in it), then draw the words or overlay as an SVG with no background and call ${IMAGE_TOOL.claude} with base_image set to the file you got back.`;
    const answer = (choice: MakerChoice): ToolResult => ({ text: choice === "both" ? BOTH_PLAN : `${OWNER_ANSWER} ${MAKER_CHOICES[choice].label}. ${todo(choice)}` });
    if (this.answered) return answer(this.answered);
    const named = imageSignals(this.c.ownerText()).explicit;
    if (named) return { text: `No need to ask: the owner's message names ${named === "both" ? "both makers" : MAKER_LABEL[named]}. ${todo(named)}` };
    if (this.c.route === "openai" || this.c.route === "claude") return { text: `No need to ask: this session is set to ${ROUTE_TITLE[this.c.route]}. ${todo(this.c.route)}` };
    const choice = await this.ask(null, request, "The agent could not tell which kind of image you want.", args.both_makes_sense === true);
    if (!choice) return fail("The owner dismissed the question in the HomeBase app. Do not make an image; ask them what they would like.");
    return answer(choice);
  }

  saveToBrand(args: Record<string, unknown>): ToolResult {
    const raw = str(args.file, 1000);
    // An SVG the agent drew is a fine brand asset too.
    const hit = this.d.store.resolveReference(raw, this.c.cwd, this.c.threadId, { svg: true });
    if (!hit.ok) return fail(hit.reason);
    const file = hit.path;
    try {
      const dest = this.d.store.toBrand(file, this.c.cwd);
      this.c.emit("system", { message: `Saved ${basename(dest)} to the ${BRAND_DIR} folder` });
      return { text: `Copied to ${dest}. It can now be passed as a reference image.` };
    } catch (err) {
      return fail(`Could not copy it: ${(err as Error).message.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------- the MCP server

const TOOL_DEFS: Record<string, { description: string; inputSchema: Record<string, z.ZodType> }> = {
  [IMAGE_TOOL.openai]: {
    description: [
      "Make ONE rendered image with OpenAI's image model, on the owner's ChatGPT plan. This is the default whenever the owner asks for an image, a graphic with imagery, a photo, an illustration, a scene or a product shot.",
      "It takes about half a minute. The owner sees the result in the session as a card marked OpenAI, and the file is saved in this working directory; you get its path back.",
      "Write a complete brief: subject, the exact wording of any text in quotes, style, colours, aspect ratio. To build on a logo or a photo, pass its path in reference_images (files in this working directory, usually under brand/).",
      "One call per image the owner asked for. Never call it again to retry or to improve a result on your own: say what happened and let the owner decide.",
      `If the request could just as well be a text or vector graphic and you cannot tell which the owner wants, call ${IMAGE_TOOL.ask} first.`,
      OWNER_ANSWER_NOTE,
    ].join(" "),
    inputSchema: {
      prompt: z.string().describe("The full image brief."),
      name: z.string().optional().describe("A short human name for the image, e.g. 'Spring sale post'."),
      reference_images: z.array(z.string()).optional().describe(`Paths of images to build on (PNG, JPEG or WebP inside this working directory, e.g. ${BRAND_DIR}/logo.png). Up to 4.`),
    },
  },
  [IMAGE_TOOL.claude]: {
    description: [
      "Store a graphic that YOU drew as an SVG. Use it for text treatments, overlays, lower-thirds, quote and title cards, badges, icons, diagrams, wordmarks and layout work, where crisp type and exact shapes matter more than rendered imagery. The owner sees it in the session as a card marked Claude.",
      `It is not for photos, illustrations or rendered scenes: those go to ${IMAGE_TOOL.openai}. If you cannot tell which the owner wants, call ${IMAGE_TOOL.ask}.`,
      "svg: one complete <svg> element with a viewBox, width and height (1080 by 1080 for a square post unless asked otherwise). Plain shapes, text, gradients and filters only. No scripts, no external images, no web fonts: use generic font families (sans-serif, serif, monospace) or very common ones (Arial, Georgia).",
      `base_image: to put the graphic ON TOP of an existing picture, pass that picture's path (for example the file ${IMAGE_TOOL.openai} returned). Draw the SVG with the same aspect ratio and no background; HomeBase composes the two into one PNG and keeps your SVG beside it.`,
      OWNER_ANSWER_NOTE,
    ].join(" "),
    inputSchema: {
      svg: z.string().describe("The complete SVG markup."),
      name: z.string().optional().describe("A short human name for the graphic."),
      description: z.string().optional().describe("One line saying what it shows."),
      base_image: z.string().optional().describe("Path of a picture to draw the graphic on top of."),
    },
  },
  [IMAGE_TOOL.ask]: {
    description:
      "Ask the owner, with one tap on their phone or desktop, who should make an image: OpenAI (a rendered picture) or you (an SVG graphic). Call it only when the request really could go either way. " +
      "Do not call it when the request is clearly a picture or clearly a text or vector graphic, or when the owner already named a maker.",
    inputSchema: {
      request: z.string().describe("What the owner asked for, in one line."),
      both_makes_sense: z.boolean().optional().describe("True when a picture with your text or overlay on top would be a sensible answer too."),
    },
  },
  [IMAGE_TOOL.brand]: {
    description: `Copy a finished image from this session into the working directory's ${BRAND_DIR}/ folder, where logos and other assets to build on are kept. Use it when the owner asks to keep an image as a brand asset.`,
    inputSchema: { file: z.string().describe(`The image's path, as returned by ${IMAGE_TOOL.openai} or ${IMAGE_TOOL.claude}.`) },
  },
};

export const STUDIO_TOOL_NAMES = Object.keys(TOOL_DEFS);

export function buildStudioMcpServer(run: StudioRun): McpServer {
  const mcp = new McpServer({ name: IMAGES_MCP_SERVER, version: "0.1.0" });
  for (const name of STUDIO_TOOL_NAMES) {
    const def = TOOL_DEFS[name];
    mcp.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, async (args: Record<string, unknown>) => {
      const r = await run.call(name, args ?? {});
      return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    });
  }
  return mcp;
}

