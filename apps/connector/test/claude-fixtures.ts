import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_TOOL_NAME, type PermissionResult } from "../src/adapters/claude-approvals";
import { defaultClaudeConfig, type ClaudeAgentConfig } from "../src/config";

/** Lines recorded from the real CLI (2.1.319) with machine paths scrubbed. No test here talks to Anthropic. */
export const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** A recording split into user turns; each turn ends with its `result` line. */
export function turnsOf(text: string): string[][] {
  const out: string[][] = [[]];
  for (const l of text.split("\n").filter(Boolean)) {
    out[out.length - 1].push(l);
    if (l.startsWith('{"duration_api_ms"') || JSON.parse(l).type === "result") out.push([]);
  }
  return out.filter((t) => t.length);
}

// `command` is a file that always exists (node itself): the adapter looks the CLI up before it spawns, and tests
// hand it a fake spawn, so they must not depend on a real `claude` being installed on the test machine.
export const testConfig = (over: Partial<ClaudeAgentConfig> = {}): ClaudeAgentConfig => ({
  ...defaultClaudeConfig({}), command: process.execPath, sandboxDir: join(tmpdir(), "homebase-claude-test"), model: "haiku", ...over,
});

export interface FakeCall {
  file: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean };
  inputs: string[];
  /** The content blocks of each turn as written to stdin (pictures included). */
  contents?: Array<Array<Record<string, any>>>;
  killed: boolean;
  /** Value of a `--flag value` pair. */
  arg(flag: string): string | undefined;
}

type Script = (call: FakeCall, turn: number, text: string) => string[] | Promise<string[]>;

/** Stands in for the `claude` child process: answers each stdin message with scripted stdout lines. */
export function fakeClaude(script: Script, opts: { exitCode?: number; stderr?: string; exitAfterTurn?: boolean; onStdinEnd?: (call: FakeCall) => void } = {}) {
  const calls: FakeCall[] = [];
  const spawn: any = (file: string, args: string[], options: any) => {
    const call: FakeCall = { file, args, options, inputs: [], contents: [], killed: false, arg: (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined) };
    calls.push(call);
    const proc: any = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = undefined; // no real process: killTree falls back to proc.kill()
    proc.exitCode = null;
    let work = Promise.resolve();
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      if (opts.stderr) proc.stderr.write(opts.stderr);
      proc.stdout.once("end", () => {
        proc.exitCode = code ?? 1;
        proc.emit("close", code);
      });
      proc.stdout.end();
    };
    let buf = "";
    proc.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines.filter(Boolean)) {
        const content = JSON.parse(l).message.content as Array<Record<string, any>>;
        call.contents!.push(content);
        const text = (content.find((b) => b.type === "text")?.text ?? "") as string;
        const turn = call.inputs.push(text) - 1;
        work = work.then(async () => {
          for (const out of await script(call, turn, text)) if (!closed) proc.stdout.write(out + "\n");
          if (opts.exitAfterTurn) close(opts.exitCode ?? 0);
        });
      }
    });
    proc.stdin.on("end", () => void work.then(() => {
      opts.onStdinEnd?.(call); // the window between "input closed" and "process gone"
      close(opts.exitCode ?? 0);
    }));
    proc.kill = () => {
      call.killed = true;
      close(null);
      return true;
    };
    return proc;
  };
  return { spawn, calls };
}

/** What the real CLI does when a tool needs permission: call the approval tool named by --mcp-config. */
export async function askApprovalTool(mcpConfig: string, request: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }): Promise<PermissionResult> {
  const server = Object.values(JSON.parse(mcpConfig).mcpServers)[0] as { url: string; headers: Record<string, string> };
  const client = new Client({ name: "fake-claude", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  try {
    const res: any = await client.callTool({ name: MCP_TOOL_NAME, arguments: request }, undefined, { timeout: 15_000 });
    return JSON.parse(res.content[0].text) as PermissionResult;
  } finally {
    await client.close();
  }
}
