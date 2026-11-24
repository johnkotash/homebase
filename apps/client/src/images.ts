import {
  MAKER_LABEL, ROUTE_LABEL, planUsageText, resolveImageRoute, toolMaker, IMAGE_TOOL, imageToolId,
  type Agent, type GeneratedImageCard, type ImageMaker, type ImageRoute, type Message, type Project, type Thread,
} from "@homebase/protocol";

/**
 * Images in a session: the words the cards, the chip and the timeline use. Pure, so the phone and the
 * desktop say exactly the same thing and the tests can read it.
 */

/** The line under the maker's name: how the work reached that provider. */
export function imageByline(card: Pick<GeneratedImageCard, "maker" | "via" | "model" | "base" | "references">): string {
  if (card.maker === "openai") return card.via;
  const overlay = /overlay/i.test(card.via);
  const on = card.base ? ` on ${card.base.maker === "openai" ? "an OpenAI" : "a Claude"} image` : overlay && card.references.length ? " on your picture" : "";
  return `${card.model ?? "Claude plan"} · SVG${overlay ? ` overlay${on}` : ""}`;
}

const KIND: Record<string, string> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "image/svg+xml": "SVG" };

export function bytesText(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** "1254 × 1254 · PNG · 1.1 MB · 26 s" */
export function imageMeta(card: Pick<GeneratedImageCard, "width" | "height" | "mime" | "bytes" | "seconds">): string {
  return [
    card.width && card.height ? `${card.width} × ${card.height}` : null, KIND[card.mime] ?? null, bytesText(card.bytes),
    card.seconds != null ? `${Math.round(card.seconds)} s` : null,
  ].filter(Boolean).join(" · ");
}

/** Width over height, for laying the picture out before it has loaded. Square when the size is unknown. */
export const imageAspect = (card: Pick<GeneratedImageCard, "width" | "height">) =>
  card.width && card.height ? Math.min(3, Math.max(1 / 3, card.width / card.height)) : 1;

/** What the client asks the hub for: the PNG preview when there is one (an SVG's rendering), else the image itself. */
export const shownArtifact = (card: Pick<GeneratedImageCard, "artifactId" | "previewId">) => card.previewId ?? card.artifactId;

export interface ImagesChip {
  route: ImageRoute;
  from: "session" | "project" | "default";
  /** "Images: Auto" */
  text: string;
  /** OpenAI is part of this setting and cannot be used right now. */
  warn: boolean;
  /** One line for under the chip or in the sheet: what is wrong and what to do. */
  note: string | null;
}

/** The chip above the message box. Null when the agent's connector offers no image tools. */
export function imagesChip(agent: Pick<Agent, "images"> | null | undefined, thread?: Pick<Thread, "imageRoute"> | null, project?: Pick<Project, "imageRoute"> | null): ImagesChip | null {
  if (!agent?.images) return null;
  const { route, from } = resolveImageRoute(thread, project);
  const needsOpenAi = route === "auto" || route === "openai" || route === "ask";
  const warn = needsOpenAi && !agent.images.openai.ready;
  return { route, from, text: `Images: ${ROUTE_LABEL[route]}`, warn, note: warn ? agent.images.openai.note ?? "OpenAI images are not available right now." : null };
}

/** One line about OpenAI for the sheet and the agent's page: the plan and its usage, or what to do to connect it. */
export function openaiLine(images: NonNullable<Agent["images"]>, now?: number): { text: string; ok: boolean } {
  const o = images.openai;
  if (!o.ready) return { ok: false, text: o.note ?? "Not connected." };
  return { ok: true, text: planUsageText(o, { now }) ?? "Signed in with ChatGPT" };
}

export interface ProjectImage {
  message: Message;
  card: GeneratedImageCard;
  thread: Thread;
}

/** Every image made in a project's sessions, newest first. Built from the cards in the conversations. */
export function projectImages(messages: Iterable<Message>, threads: Record<string, Thread>, projectId: string): ProjectImage[] {
  const out: ProjectImage[] = [];
  for (const m of messages) {
    if (m.card?.type !== "generated_image") continue;
    const thread = threads[m.threadId];
    if (thread?.projectId === projectId) out.push({ message: m, card: m.card, thread });
  }
  return out.sort((a, b) => b.message.createdAt - a.message.createdAt);
}

/** How a tool call reads on the run timeline: image tools carry their provider's name instead of an MCP id. */
export function toolLabel(tool: string | null | undefined): { label: string; maker: ImageMaker | null } {
  const maker = toolMaker(tool);
  if (maker) return { label: `${MAKER_LABEL[maker]} · ${maker === "openai" ? "make image" : "draw graphic"}`, maker };
  if (tool === imageToolId(IMAGE_TOOL.ask)) return { label: "Ask · who makes it", maker: null };
  if (tool === imageToolId(IMAGE_TOOL.brand)) return { label: "Brand folder · save", maker: null };
  return { label: tool ?? "tool", maker: null };
}

/**
 * What a provider is doing in a live run right now, from the run's own events: set when the connector says
 * OpenAI has started on an image, cleared when the image (or the reason there is none) arrives.
 */
export function liveImageWork(events: Array<{ kind: string; data: Record<string, unknown> }> | null | undefined): { maker: ImageMaker; text: string } | null {
  let at: { maker: ImageMaker; text: string } | null = null;
  for (const e of events ?? []) {
    if (e.kind !== "system") continue;
    const d = e.data as { imageRoute?: { action?: string; maker?: ImageMaker }; imageCard?: unknown; imageIssue?: unknown; message?: unknown };
    if (d.imageCard || d.imageIssue) at = null;
    else if (d.imageRoute?.action === "proceed" && d.imageRoute.maker === "openai") {
      at = { maker: "openai", text: String(d.message ?? "OpenAI is making the image").split(". ")[0].replace(/[.…]+$/, "") };
    }
  }
  return at;
}

/** The title of an image tool's step on the timeline: the image's name, else the start of its brief. Null for any other tool. */
export function imageStepTitle(tool: string | null | undefined, input: unknown): string | null {
  if (!tool || !tool.startsWith("mcp__images__")) return null;
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ["name", "description", "prompt", "request", "file"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return "";
}
