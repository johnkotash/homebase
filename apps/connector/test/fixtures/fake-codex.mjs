#!/usr/bin/env node
// Stands in for the Codex CLI in tests. No test talks to OpenAI.
//   FAKE_CODEX_MODE  ok (default) | logged_out | api_key | limit | refuse | no_image | hang
//   FAKE_CODEX_LOG   a file that gets one JSON line per `exec` call: the arguments and the brief from stdin
//   CODEX_HOME       where the "generated" image is written, as the real CLI does
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
// A valid 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

if (args[0] === "--version") {
  console.log("codex-cli 9.9.9");
} else if (args[0] === "login" && args[1] === "status") {
  if (mode === "logged_out") {
    console.error("Not logged in");
    process.exit(1);
  }
  console.error(mode === "api_key" ? "Logged in using an API key - sk-fake-***" : "Logged in using ChatGPT");
} else if (args[0] === "app-server") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id === 1) out({ id: 1, result: { userAgent: "fake" } });
    if (m.id === 2) {
      out({ id: 2, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1795716883 }, secondary: null, planType: "plus", rateLimitReachedType: null } } });
    }
  });
} else if (args[0] === "exec") {
  let brief = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (brief += d));
  process.stdin.on("end", () => {
    if (process.env.FAKE_CODEX_LOG) {
      appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, brief, keys: Object.keys(process.env).filter((k) => /OPENAI|CODEX_API/i.test(k)) }) + "\n");
    }
    const thread = `0199fake-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    out({ type: "thread.started", thread_id: thread });
    out({ type: "turn.started" });
    if (mode === "hang") return void setInterval(() => {}, 1000);
    if (mode === "limit") {
      out({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again at 6:14 PM." } });
      return process.exit(1);
    }
    if (mode === "refuse") {
      out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I can't create that image because it violates the content policy." } });
      out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
      return;
    }
    if (mode !== "no_image") {
      const dir = join(process.env.CODEX_HOME, "generated_images", thread);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "exec-1.png"), PNG);
    }
    out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: mode === "no_image" ? "Done." : "Created one square graphic." } });
    out({ type: "turn.completed", usage: { input_tokens: 72120, cached_input_tokens: 57344, output_tokens: 386 } });
  });
} else {
  console.error(`fake-codex: unexpected arguments ${args.join(" ")}`);
  process.exit(2);
}
