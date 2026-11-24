import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessTokens, REQUIRED_SCOPES, endpointsFromEnv, gmailPaths, saveToken } from "../src/gmail/auth";
import { GmailClient } from "../src/gmail/client";
import { GMAIL_MCP_SERVER } from "../src/gmail/tools";
import type { FakeGmail } from "./fake-gmail";

/** A data directory with a Desktop-app client file and, unless asked otherwise, a stored grant for the fake mailbox. */
export function gmailBox(fake: FakeGmail, opts: { connected?: boolean; clientFile?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hb-gmail-"));
  const env: NodeJS.ProcessEnv = { HOMEBASE_DATA_DIR: dir, HB_GMAIL_FAKE_BASE: fake.url };
  const paths = gmailPaths(env);
  mkdirSync(paths.secretsDir, { recursive: true });
  if (opts.clientFile !== false) writeFileSync(paths.clientJson, JSON.stringify({ installed: { client_id: "test-client-id.apps.googleusercontent.com", client_secret: "test-client-secret", redirect_uris: ["http://localhost"] } }));
  if (opts.connected !== false) saveToken(paths, { refreshToken: "fake-refresh-token", scopes: [...REQUIRED_SCOPES], account: fake.account, obtainedAt: Date.now() });
  const endpoints = endpointsFromEnv(env);
  const tokens = new AccessTokens({ paths, endpoints });
  const client = new GmailClient({ tokens, endpoints });
  return { dir, env, paths, endpoints, tokens, client };
}

/** Talks to the Gmail MCP server the way the CLI does, using the entry from a run's --mcp-config. */
export async function gmailMcp(mcpConfig: string) {
  const server = JSON.parse(mcpConfig).mcpServers[GMAIL_MCP_SERVER] as { url: string; headers: Record<string, string> };
  const client = new Client({ name: "fake-claude", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  return {
    list: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
      return { text: String(res.content?.[0]?.text ?? ""), isError: res.isError === true };
    },
    close: () => client.close(),
  };
}

const SESSION = "306b18cd-e629-4f05-80d2-39435a768c6a";
/** The stdout lines of one short, successful CLI turn. */
export const cliTurn = (text: string, first = true): string[] => [
  ...(first ? [JSON.stringify({ type: "system", subtype: "init", session_id: SESSION, model: "claude-haiku-test", apiKeySource: "none", cwd: ".", tools: [], mcp_servers: [] })] : []),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: SESSION, total_cost_usd: 0, num_turns: 1, duration_ms: 5 }),
];
