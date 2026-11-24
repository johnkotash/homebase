import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VAULT_MCP_SERVER, buildVaultMcpServer, type VaultTools } from "./tools";

/**
 * Loopback-only HTTP endpoint for the vault MCP server (the same shape as the Gmail host). Each run
 * binds its own random bearer token, so a tool call reaches only the run whose CLI process was handed it.
 */
export class VaultMcpHost {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private bindings = new Map<string, VaultTools>();
  port = 0;

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((ok, fail) => {
      const server = createServer((req, res) => void this.onRequest(req, res));
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        server.unref();
        ok();
      });
    });
    return this.starting;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/vault`;
  }

  /** Registers a run's tools. Returns the `mcpServers` entry for its CLI process and a release function. */
  bind(tools: VaultTools): { servers: Record<string, unknown>; release(): void } {
    const token = randomBytes(24).toString("hex");
    this.bindings.set(token, tools);
    return {
      servers: { [VAULT_MCP_SERVER]: { type: "http", url: this.url, headers: { Authorization: `Bearer ${token}` } } },
      release: () => void this.bindings.delete(token),
    };
  }

  async stop() {
    this.bindings.clear();
    const s = this.server;
    this.server = null;
    this.starting = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private lookup(req: IncomingMessage): VaultTools | null {
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    for (const [token, tools] of this.bindings) {
      const a = Buffer.from(token);
      const b = Buffer.from(m[1]);
      if (a.length === b.length && timingSafeEqual(a, b)) return tools;
    }
    return null;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const json = (code: number, message: string) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };
    try {
      if (!req.url?.startsWith("/vault")) return json(404, "Not found");
      const tools = this.lookup(req);
      if (!tools) return json(401, "Unauthorized");
      if (req.method !== "POST") return json(405, "Method not allowed");
      const mcp = buildVaultMcpServer(tools);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, keepAliveMs: 15_000 } as any);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) json(500, (err as Error).message ?? "Internal error");
    }
  }
}
