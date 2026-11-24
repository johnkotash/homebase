import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BROWSER_MCP_SERVER } from "@homebase/protocol";
import { KEYS } from "./driver";
import { UNTRUSTED_PAGE_TAG, type BrowserNode, type Reply, type RunBrowser } from "./node";

/**
 * The browser tools one run of an agent gets (docs/BROWSER-AGENT-PLAN.md 4.4). The same server works for
 * any MCP client: the rules are in the node behind it, not in the client's own permission prompts.
 *
 * What is deliberately not here: running script in a page, reading cookies or storage, looking at network
 * requests, uploading or downloading files.
 */

const Ref = z.string().regex(/^e\d{1,7}$/, "a reference from the page outline, such as e12");

export const BROWSER_TOOL_NAMES = [
  "browser_open", "browser_snapshot", "browser_scroll", "browser_find", "browser_back", "browser_tabs", "browser_status",
  "browser_click", "browser_type", "browser_press_key", "browser_select", "browser_request_owner",
] as const;
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

export const BROWSER_TOOL_DEFS: Record<BrowserToolName, { description: string; inputSchema: Record<string, z.ZodType> }> = {
  browser_open: {
    description:
      "Open a web address in the HomeBase browser and read the page. The page comes back as an outline: one line for each link, button and field, " +
      "with a reference like [e12], and the visible text between them. The owner can watch this browser live and may take it over at any time. " +
      "Only the public web: no addresses on this machine or a private network. Page loads are paced per site.",
    inputSchema: { url: z.string().min(1).max(2000).describe("The address, for example https://example.com/page") },
  },
  browser_snapshot: {
    description: "Read the page that is open now, as an outline with references. Use scope \"viewport\" for only what is on screen, after scrolling a long page.",
    inputSchema: { scope: z.enum(["page", "viewport"]).optional() },
  },
  browser_scroll: {
    description: "Scroll the page and read what is then on screen.",
    inputSchema: { direction: z.enum(["down", "up", "top", "bottom"]) },
  },
  browser_find: {
    description: "Look for some text on the page that is open. Scrolls to the first place it appears and shows each place with a little context.",
    inputSchema: { text: z.string().min(1).max(200) },
  },
  browser_back: { description: "Go back to the previous page in this tab and read it.", inputSchema: {} },
  browser_tabs: {
    description: "List the open tabs, bring one to the front, or close one. A link that opens a new tab is followed automatically.",
    inputSchema: { action: z.enum(["list", "select", "close"]), index: z.number().int().min(0).max(50).optional() },
  },
  browser_status: {
    description: "What the browser is showing, and what you may do in it right now: the mode, the sites where you may act without asking, and the pace allowed per site.",
    inputSchema: {},
  },
  browser_click: {
    description:
      "Click something by its reference from the latest outline. Following a link or opening a \"see more\" just happens. Any other click (a button, a checkbox, " +
      "a form) may first be put to the owner as a one-tap approval, and this call waits for the answer. Never used on password or code fields.",
    inputSchema: { ref: Ref },
  },
  browser_type: {
    description:
      "Type text into a field by its reference, replacing what is there. With submit, Enter is pressed afterwards. Typing may first be put to the owner, who sees the exact text. " +
      "Passwords, one-time codes and card numbers are always refused: call browser_request_owner and the owner does those by hand.",
    inputSchema: { ref: Ref, text: z.string().max(4000), submit: z.boolean().optional() },
  },
  browser_press_key: {
    description: `Press one key: ${Object.keys(KEYS).join(", ")}. Keys that only move the view are free; Enter, Tab and the rest count as acting and may ask the owner.`,
    inputSchema: { key: z.string().min(1).max(20) },
  },
  browser_select: {
    description: "Choose in a drop-down list by its reference, by the option's text or value. May ask the owner first.",
    inputSchema: { ref: Ref, values: z.array(z.string().min(1).max(200)).min(1).max(10) },
  },
  browser_request_owner: {
    description:
      "Ask the owner to do something in the browser by hand: sign in, enter a code, answer an are-you-human check, accept a consent banner. " +
      "The browser is held for them and this call waits until they hand it back or decline. Say in a few words what is needed.",
    inputSchema: { reason: z.string().min(3).max(200) },
  },
};

export function callBrowserTool(node: BrowserNode, run: RunBrowser, name: BrowserToolName, a: Record<string, any>): Promise<Reply> {
  switch (name) {
    case "browser_open": return node.open(run, String(a.url ?? ""));
    case "browser_snapshot": return node.snapshot(run, a.scope === "viewport" ? "viewport" : "page");
    case "browser_scroll": return node.scroll(run, a.direction);
    case "browser_find": return node.find(run, String(a.text ?? ""));
    case "browser_back": return node.back(run);
    case "browser_tabs": return node.tabs(run, a.action, typeof a.index === "number" ? a.index : undefined);
    case "browser_status": return node.status(run);
    case "browser_click": return node.click(run, String(a.ref));
    case "browser_type": return node.type(run, String(a.ref), String(a.text ?? ""), a.submit === true);
    case "browser_press_key": return node.pressKey(run, String(a.key));
    case "browser_select": return node.select(run, String(a.ref), (a.values as string[]) ?? []);
    case "browser_request_owner": return node.requestOwner(run, String(a.reason ?? ""));
  }
}

/** Builds the MCP server for one request of one run. Stateless: a fresh instance per HTTP call. */
export function buildBrowserMcpServer(node: BrowserNode, run: RunBrowser): McpServer {
  const mcp = new McpServer({ name: BROWSER_MCP_SERVER, version: "0.1.0" });
  for (const name of BROWSER_TOOL_NAMES) {
    const def = BROWSER_TOOL_DEFS[name];
    mcp.registerTool(name, { description: def.description, inputSchema: def.inputSchema }, async (args: Record<string, unknown>) => {
      const r = await callBrowserTool(node, run, name, args ?? {});
      return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    });
  }
  return mcp;
}

/** Takes page text out of a tool result, for places that must not hold other people's words (the run timeline). */
export function withholdPages(text: string): string {
  const re = new RegExp(`<${UNTRUSTED_PAGE_TAG}>\\n([\\s\\S]*?)(?:\\n</${UNTRUSTED_PAGE_TAG}>|$)`, "g");
  let chars = 0;
  let n = 0;
  const out = text.replace(re, (_m, body: string) => {
    n++;
    chars += body.length;
    return "";
  });
  return n ? `${out.replace(/\n{3,}/g, "\n\n").trim()}\n[Page text read by the agent: ${chars} characters. It is not copied into HomeBase.]` : text;
}
