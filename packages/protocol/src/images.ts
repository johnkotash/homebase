import { z } from "zod";

/**
 * Images in a session, made by more than one provider (docs/MULTI-PROVIDER-PLAN.md).
 *
 * Two makers. "openai": OpenAI's image model, through the official Codex CLI under the ChatGPT login
 * on the connector machine. "claude": the session's own Claude agent, which writes an SVG (text
 * treatments, overlays, vector and layout work). The agent picks a tool; this file holds the rule that
 * decides whether that pick goes ahead, is sent the other way, or is put to the owner as a one-tap
 * question. The connector applies the rule and stamps who made what; clients only show it.
 */

export const IMAGE_MAKERS = ["openai", "claude"] as const;
export const ImageMaker = z.enum(IMAGE_MAKERS);
export type ImageMaker = z.infer<typeof ImageMaker>;

/** The provider's name wherever a made thing is attributed. */
export const MAKER_LABEL: Record<ImageMaker, string> = { openai: "OpenAI", claude: "Claude" };
/** How the work reached the provider, said plainly under the name. */
export const MAKER_VIA: Record<ImageMaker, string> = { openai: "ChatGPT plan · via Codex CLI", claude: "Claude plan · SVG" };

/** The answers the owner can give when HomeBase asks who should make an image. The labels are what is tapped. */
export const MAKER_CHOICES = {
  openai: { label: "OpenAI image", description: "A rendered picture: photos, illustrations, scenes. Made on your ChatGPT plan." },
  claude: { label: "Claude overlay / SVG", description: "Crisp text, shapes and layout as a vector graphic. Made by Claude." },
  both: { label: "Both", description: "OpenAI makes the picture, then Claude puts the text or overlay on top of it." },
} as const;
export type MakerChoice = keyof typeof MAKER_CHOICES;
export const MAKER_QUESTION = "Who should make this image?";

/** The choice behind a tapped label. Null for anything else. */
export function choiceFromLabel(label: unknown): MakerChoice | null {
  if (typeof label !== "string") return null;
  const hit = (Object.keys(MAKER_CHOICES) as MakerChoice[]).find((k) => MAKER_CHOICES[k].label.toLowerCase() === label.trim().toLowerCase());
  return hit ?? null;
}

// ---------------------------------------------------------------- the setting

/**
 * What a session (or a project, as the default for its sessions) lets happen when an image is asked for.
 * auto: go ahead when it is clear which maker fits, ask when it is not. openai / claude: always that one,
 * unless the message names the other. ask: always ask. off: the agent gets no image tools.
 */
export const IMAGE_ROUTES = ["auto", "openai", "claude", "ask", "off"] as const;
export const ImageRoute = z.enum(IMAGE_ROUTES);
export type ImageRoute = z.infer<typeof ImageRoute>;
export const DEFAULT_IMAGE_ROUTE: ImageRoute = "auto";

export const ROUTE_LABEL: Record<ImageRoute, string> = { auto: "Auto", openai: "OpenAI", claude: "Claude", ask: "Ask me", off: "Off" };
export const ROUTE_TITLE: Record<ImageRoute, string> = {
  auto: "Auto: the right one for the job", openai: "Always OpenAI", claude: "Always Claude", ask: "Ask me every time", off: "Off",
};
export const ROUTE_BLURB: Record<ImageRoute, string> = {
  auto: "Pictures and photos go to OpenAI. Text treatments, overlays and vector graphics are made by Claude. You are asked only when it is unclear.",
  openai: "Every image is made by OpenAI on your ChatGPT plan, unless your message names Claude.",
  claude: "Every graphic is made by Claude as an SVG, unless your message names OpenAI.",
  ask: "Before each image you get a one-tap question: OpenAI image or Claude overlay / SVG.",
  off: "The agent gets no image tools in this session.",
};

/** The setting in force: the session's own, else its project's, else Auto. */
export function resolveImageRoute(
  thread?: { imageRoute?: ImageRoute | null } | null, project?: { imageRoute?: ImageRoute | null } | null,
): { route: ImageRoute; from: "session" | "project" | "default" } {
  const own = ImageRoute.safeParse(thread?.imageRoute);
  if (own.success) return { route: own.data, from: "session" };
  const proj = ImageRoute.safeParse(project?.imageRoute);
  if (proj.success) return { route: proj.data, from: "project" };
  return { route: DEFAULT_IMAGE_ROUTE, from: "default" };
}

/** The workspace setting that makes Claude look at each finished image and compare it with the brief. Off unless true. */
export const IMAGE_CHECK_SETTING = "images.check";

/** What the hub tells a connector about images when it starts a run. */
export const RunImageOptions = z.object({ route: ImageRoute, check: z.boolean().optional() });
export type RunImageOptions = z.infer<typeof RunImageOptions>;

// ---------------------------------------------------------------- tools (names shared by the connector and the timeline)

export const IMAGES_MCP_SERVER = "images";
export const IMAGE_TOOL = { openai: "openai_image", claude: "claude_graphic", ask: "choose_maker", brand: "save_to_brand" } as const;
export const imageToolId = (name: string) => `mcp__${IMAGES_MCP_SERVER}__${name}`;
export const isImageTool = (tool: string | null | undefined) => !!tool && tool.startsWith(`mcp__${IMAGES_MCP_SERVER}__`);
/** Which provider a tool call belongs to, from the tool's own name. Null for every tool that is not an image tool. */
export function toolMaker(tool: string | null | undefined): ImageMaker | null {
  if (tool === imageToolId(IMAGE_TOOL.openai)) return "openai";
  if (tool === imageToolId(IMAGE_TOOL.claude)) return "claude";
  return null;
}

// ---------------------------------------------------------------- reading the owner's words

export interface ImageSignals {
  /** A maker the owner named. "both" when the message names the two of them. */
  explicit: ImageMaker | "both" | null;
  /** Words that point at a rendered picture. */
  picture: string[];
  /** Words that point at text, overlay, vector or layout work. */
  vector: string[];
}

const NAMES_OPENAI = /\b(open\s?ai|chat\s?gpt|gpt(?:[- ]?image)?(?:[- ]?\d+(?:\.\d+)?)?|dall[- ]?e)\b/i;
// "Claude" alone is how the owner addresses the agent, so it only counts when it is asked to do the making.
const NAMES_CLAUDE = /\b(?:(?:with|by|using|use|have|let|via|from)\s+claude|claude\s+(?:should|can|could|to|will)?\s*(?:make|draw|create|do|design|build|write)|claude(?:'s)?\s+(?:svg|overlay|graphic|vector|version))\b/i;

const PICTURE_WORDS: Array<[string, RegExp]> = [
  ["photo", /\bphoto(?:s|graph|graphs|graphy|graphic)?\b/i],
  ["photorealistic", /\bphoto[- ]?real(?:istic|ism)?\b|\brealistic\b|\blifelike\b/i],
  ["picture", /\bpicture(?:s)?\b|\bpic(?:s)?\b/i],
  ["illustration", /\billustrat(?:ion|ions|ed|e)\b/i],
  ["painting", /\bpaint(?:ing|ed)\b|\bwatercolou?r\b|\boil painting\b/i],
  ["render", /\b(?:3d|3-d)\b|\brender(?:ed|ing)?\b|\bcinematic\b/i],
  ["scene", /\bscene\b|\bportrait of\b|\blandscape of\b/i],
  ["mockup", /\bmock-?up\b|\bproduct shot\b|\bhero image\b|\blifestyle (?:shot|image)\b/i],
  ["artwork", /\bartwork\b|\bconcept art\b|\bsketch of\b|\bdrawing of\b|\btexture\b/i],
  ["image of", /\b(?:image|graphic) (?:of|showing|with a (?:person|man|woman|dog|cat|car|house))\b/i],
];
// Only words that ask for the graphic itself. Words that often just describe a picture or name something to
// build on ("our wordmark", "a thin border", "the logo") are left out on purpose: a false signal here means a
// question the owner did not need.
const VECTOR_WORDS: Array<[string, RegExp]> = [
  ["SVG", /\bsvg\b/i],
  ["vector", /\bvector(?:s|ised|ized)?\b/i],
  ["overlay", /\boverlay(?:s)?\b|\blower[- ]third\b/i],
  ["text treatment", /\btext (?:treatment|effect|only|overlay)\b|\btypograph(?:y|ic)\b|\blettering\b|\bjust (?:the )?text\b/i],
  ["caption", /\bcaption (?:bar|card|strip)\b|\btitle card\b|\bquote card\b/i],
  ["icon", /\bicon set\b|\b(?:an?|new|simple|flat|line|vector)\s+icon\b|\bicons\b|\bpictogram\b/i],
  ["diagram", /\bdiagram\b|\bflow ?chart\b|\bchart\b|\binfographic\b|\bwireframe\b/i],
  ["watermark", /\bwatermark\b/i],
  ["transparent", /\btransparent\b/i],
];

/** A file the message points at ("brand/logo.svg", "wordmark.png"): something to build on, not a description of what to make. */
const FILE_NAME = /[\w./\\:~-]*\.(?:png|jpe?g|webp|gif|svg|pdf|psd|ai)\b/gi;

/** "on that photo", "to the last image": words about a picture that already exists, which is not a request for one. */
const EXISTING = /\b(?:on|onto|over|to|in|into|from|across|above|below|under)\s+(?:top of\s+)?(?:that|this|the|my|our|those|these|its)\s+(?:(?:last|previous|same|existing|first|second|new|other)\s+)?(?:photo(?:graph)?|picture|pic|image|illustration|render|shot)s?\b/gi;

/** What the owner's message says about who should make the image. */
export function imageSignals(text: string | null | undefined): ImageSignals {
  const t = String(text ?? "").replace(FILE_NAME, " ");
  const o = NAMES_OPENAI.test(t);
  const c = NAMES_CLAUDE.test(t);
  const asked = t.replace(EXISTING, " ");
  // The owner's own words are what is quoted back ("lower third", not a category name), so the reason reads true.
  const heard = (words: Array<[string, RegExp]>, s: string) => {
    const all = words.map(([, re]) => re.exec(s)?.[0].trim().toLowerCase()).filter((w): w is string => !!w);
    // "text overlay" already says "overlay": the longer phrase is kept.
    return all.filter((w) => !all.some((x) => x !== w && x.includes(w)));
  };
  return {
    explicit: o && c ? "both" : o ? "openai" : c ? "claude" : null,
    picture: heard(PICTURE_WORDS, asked),
    vector: heard(VECTOR_WORDS, t),
  };
}

// ---------------------------------------------------------------- the rule

export type RouteBasis =
  | "answer"    // the owner already answered the question in this run
  | "explicit"  // the owner named the maker in the message
  | "setting"   // the session or project is set to one maker, or to always ask
  | "clear"     // the words point one way and the agent went that way
  | "default"   // nothing said either way: pictures are the default
  | "continue"  // nothing said either way, and the session's last image came from this maker
  | "mixed"     // the words point both ways
  | "disagree"  // the words point one way and the agent went the other
  | "unclear";  // nothing said either way and the agent left the default

export type RouteDecision =
  | { action: "proceed"; maker: ImageMaker; basis: RouteBasis; why: string }
  | { action: "redirect"; maker: ImageMaker; basis: RouteBasis; why: string }
  | { action: "ask"; basis: RouteBasis; why: string; offerBoth: boolean };

export interface RouteInput {
  setting: ImageRoute;
  /** The owner's latest message in the run. */
  ownerText: string;
  /** The maker whose tool the agent called. */
  called: ImageMaker;
  /** The owner's answer to the question earlier in this run, if there was one. */
  answered?: MakerChoice | null;
  /** The maker of the session's last image, if any. */
  lastMaker?: ImageMaker | null;
}

const other = (m: ImageMaker): ImageMaker => (m === "openai" ? "claude" : "openai");
const list = (w: string[]) => w.slice(0, 3).map((x) => `"${x}"`).join(", ");

/**
 * Go ahead, send the agent to the other maker, or ask the owner. In order: an answer already given in
 * this run, a maker named in the message, the session's standing choice, then the words of the request.
 * A rendered picture is the default, so OpenAI goes ahead on a request that says nothing either way.
 */
export function decideImageRoute(i: RouteInput): RouteDecision {
  const s = imageSignals(i.ownerText);
  const go = (basis: RouteBasis, why: string): RouteDecision => ({ action: "proceed", maker: i.called, basis, why });
  const send = (maker: ImageMaker, basis: RouteBasis, why: string): RouteDecision => ({ action: "redirect", maker, basis, why });

  if (i.answered) {
    if (i.answered === "both" || i.answered === i.called) return go("answer", `You chose ${MAKER_CHOICES[i.answered].label}.`);
    return send(i.answered, "answer", `You chose ${MAKER_CHOICES[i.answered].label}.`);
  }
  if (s.explicit) {
    if (s.explicit === "both" || s.explicit === i.called) return go("explicit", `Your message asked for ${s.explicit === "both" ? "both" : MAKER_LABEL[i.called]} by name.`);
    return send(s.explicit, "explicit", `Your message asked for ${MAKER_LABEL[s.explicit]} by name.`);
  }
  if (i.setting === "openai" || i.setting === "claude") {
    if (i.setting === i.called) return go("setting", `This session is set to ${ROUTE_TITLE[i.setting]}.`);
    return send(i.setting, "setting", `This session is set to ${ROUTE_TITLE[i.setting]}.`);
  }
  const pic = s.picture.length > 0;
  const vec = s.vector.length > 0;
  if (i.setting === "ask") return { action: "ask", basis: "setting", why: "This session is set to ask before every image.", offerBoth: pic && vec };
  if (pic && vec) {
    return { action: "ask", basis: "mixed", offerBoth: true, why: `Your message points both ways: ${list(s.picture)} sounds like a picture, ${list(s.vector)} like a graphic.` };
  }
  if (pic) {
    return i.called === "openai" ? go("clear", `Your message asks for a picture (${list(s.picture)}).`)
      : { action: "ask", basis: "disagree", offerBoth: false, why: `Your message sounds like a picture (${list(s.picture)}), but the agent wanted to draw it itself.` };
  }
  if (vec) {
    return i.called === "claude" ? go("clear", `Your message asks for a graphic (${list(s.vector)}).`)
      : { action: "ask", basis: "disagree", offerBoth: false, why: `Your message sounds like a graphic (${list(s.vector)}), but the agent wanted a rendered picture.` };
  }
  if (i.called === "openai") return go("default", "Nothing in your message said otherwise, so it is a rendered picture.");
  if (i.lastMaker === "claude") return go("continue", "The last graphic in this session was made by Claude.");
  return { action: "ask", basis: "unclear", offerBoth: false, why: "Your message did not say what kind of image, and the agent wanted to draw it itself." };
}

/** The one-tap question, as an approval of kind "question". */
export function makerQuestion(offerBoth: boolean) {
  const keys: MakerChoice[] = offerBoth ? ["openai", "claude", "both"] : ["openai", "claude"];
  return { question: MAKER_QUESTION, header: "Image", multiSelect: false, options: keys.map((k) => ({ label: MAKER_CHOICES[k].label, description: MAKER_CHOICES[k].description })) };
}

// ---------------------------------------------------------------- what the session shows

const ARTIFACT_ID = /^art_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:p)?$/;
export const isArtifactId = (id: unknown): id is string => typeof id === "string" && ARTIFACT_ID.test(id);
export const ArtifactId = z.string().regex(ARTIFACT_ID);
/** The id of the PNG preview stored next to an SVG. */
export const previewIdOf = (artifactId: string) => `${artifactId}p`;

/** One finished image in a session. The connector fills in every field; nothing here comes from the model's own words except `prompt`. */
export const GeneratedImageCard = z.object({
  type: z.literal("generated_image"),
  artifactId: ArtifactId,
  /** A PNG the clients can always draw (the rendered SVG, or an overlay put on its base picture). Null: draw the artifact itself. */
  previewId: ArtifactId.nullable().optional(),
  maker: ImageMaker,
  via: z.string().max(120),
  /** The model that made it, when the provider says. */
  model: z.string().max(80).nullable(),
  name: z.string().max(120),
  /** OpenAI: the brief exactly as sent. Claude: its one-line description of the graphic. */
  prompt: z.string().max(8000),
  mime: z.string().max(60),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative(),
  seconds: z.number().nonnegative().nullable(),
  /** Where the file was saved on the connector machine. */
  savedPath: z.string().max(1000).nullable(),
  references: z.array(z.string().max(300)).max(8),
  /** Why this maker: the routing rule's basis, in the owner's words. */
  routedWhy: z.string().max(300).nullable().optional(),
  /** A Claude overlay drawn on top of another image: who made that one. */
  base: z.object({ maker: ImageMaker, name: z.string().max(120) }).nullable().optional(),
  /** False when the bytes could not be sent to the hub; the file is still on the connector machine. */
  stored: z.boolean().optional(),
});
export type GeneratedImageCard = z.infer<typeof GeneratedImageCard>;

/** An image that was not made, and why, with the provider's name on it. */
export const ImageIssueCard = z.object({
  type: z.literal("image_issue"),
  maker: ImageMaker,
  /** not_ready: the CLI is missing or signed out. limit: a HomeBase cap or the provider's own limit. failed: the provider returned no image. */
  reason: z.enum(["not_ready", "limit", "failed", "refused"]),
  title: z.string().max(200),
  message: z.string().max(1000),
  /** What to do about it, e.g. the command to run on the connector machine. */
  hint: z.string().max(300).nullable().optional(),
});
export type ImageIssueCard = z.infer<typeof ImageIssueCard>;

/** The messages the buttons on an image card send. They name the maker, so the router has nothing to ask. */
export const IMAGE_ACTIONS = {
  regenerate: (c: Pick<GeneratedImageCard, "maker" | "name">) =>
    c.maker === "openai" ? `Make "${c.name}" again with OpenAI, same brief.` : `Make "${c.name}" again with Claude as an SVG, same brief.`,
  switchMaker: (c: Pick<GeneratedImageCard, "maker" | "name">) =>
    c.maker === "openai" ? `Make "${c.name}" again, this time with Claude as an SVG graphic.` : `Make "${c.name}" again, this time with OpenAI as a rendered image.`,
  toBrand: (c: Pick<GeneratedImageCard, "name">) => `Save "${c.name}" to this project's brand folder.`,
} as const;

// ---------------------------------------------------------------- what the connector reports

/**
 * What a connector knows about making images for an agent. Facts only: flags, a version, the plan's
 * name and usage numbers. Never a token, an account name or anything read from a credential file.
 */
export const AgentImagesStatus = z.object({
  openai: z.object({
    /** The Codex CLI is installed and signed in with a ChatGPT account. */
    ready: z.boolean(),
    cliVersion: z.string().max(60).nullable(),
    signedIn: z.boolean().nullable(),
    /** "chatgpt" or "api_key", as the CLI reports. */
    method: z.string().max(40).nullable(),
    /** Why OpenAI images cannot be made right now, with the command that fixes it. Null when ready. */
    note: z.string().max(300).nullable(),
    plan: z.string().max(40).nullable(),
    /** The plan's usage window, as the CLI reports it. */
    usedPercent: z.number().min(0).max(100).nullable(),
    windowMins: z.number().int().nonnegative().nullable(),
    resetsAt: z.number().int().nullable(),
    imagesLastHour: z.number().int().nonnegative(),
    capPerHour: z.number().int().nonnegative(),
    capPerRun: z.number().int().nonnegative(),
    checkedAt: z.number().int(),
  }),
  claude: z.object({
    /** Claude's SVGs can be turned into PNG previews and put on top of other images on this machine. */
    canRender: z.boolean(),
  }),
  /** Where finished images are saved, relative to a session's working directory. */
  saveDir: z.string().max(200),
  brandDir: z.string().max(200),
});
export type AgentImagesStatus = z.infer<typeof AgentImagesStatus>;

/** "ChatGPT Plus · 4% of this week used · resets Thu 18:14", from the numbers a connector reports. Null when it reports none. */
export function planUsageText(o: AgentImagesStatus["openai"], opts: { now?: number; locale?: string } = {}): string | null {
  if (o.usedPercent == null) return o.plan ? `ChatGPT ${cap(o.plan)}` : null;
  const span = o.windowMins == null ? "" : o.windowMins >= 10_000 ? " of this week" : o.windowMins >= 1_400 ? " of today" : ` of this ${Math.round(o.windowMins / 60)} h window`;
  const parts = [o.plan ? `ChatGPT ${cap(o.plan)}` : "ChatGPT plan", `${Math.round(o.usedPercent)}%${span} used`];
  if (o.resetsAt) {
    const d = new Date(o.resetsAt);
    parts.push(`resets ${d.toLocaleDateString(opts.locale ?? "en-US", { weekday: "short" })} ${d.toLocaleTimeString(opts.locale ?? "en-US", { hour: "numeric", minute: "2-digit" })}`);
  }
  return parts.join(" · ");
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
