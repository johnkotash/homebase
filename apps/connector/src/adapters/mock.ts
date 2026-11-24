import { RECAP_PROMPT, newId, type Risk } from "@homebase/protocol";
import { classify } from "../policy";
import type { AgentAdapter, RunContext, RunHandle } from "./types";

export interface MockOptions {
  /** 1 = the documented pacing (about 2 s of streaming). Tests use a small fraction. */
  speed?: number;
}

class Cancelled extends Error {}

/** What the scripted agent says to "security audit": every tone and a callout, as a real agent would write them. */
export const TONE_DEMO = [
  "## Security audit",
  "Found :critical[an SQL injection in `/api/login`] and :warning[two dependencies past end of life]. :success[All 42 tests pass] on the fix branch.",
  "",
  "> [!critical] Fix before the next deploy",
  "> The `email` field is concatenated into the query. A parameterised query closes it.",
  "",
  "- :info[Scope] the public API and the checkout flow",
  "- **Next** rotate the staging keys, then deploy",
].join("\n");

const GATED = /deploy|delete|send|push|pay/i;
const HIGH = /deploy|delete|pay/i;

/** The action the scripted agent "wants" to take for a prompt, shaped like a real tool call. */
export function plannedAction(text: string): { tool: string; title: string; input: Record<string, unknown>; summary: string; risk: Risk } | null {
  const m = text.match(GATED);
  if (!m) return null;
  const risk: Risk = HIGH.test(text) ? "high" : "medium";
  const word = (text.match(HIGH) ?? m)[0].toLowerCase();
  const env = /staging/i.test(text) ? "staging" : "production";
  switch (word) {
    case "deploy":
      return { tool: "Bash", title: `Deploy to ${env}`, input: { command: `wrangler deploy --env ${env}` }, summary: `wrangler deploy --env ${env}`, risk };
    case "delete":
      return { tool: "Bash", title: "Delete data", input: { command: "psql $DATABASE_URL -c \"DELETE FROM form_submissions WHERE is_test = true\"" }, summary: "DELETE FROM form_submissions WHERE is_test = true", risk };
    case "pay":
      return { tool: "payments.create", title: "Pay an invoice", input: { vendor: "Hosting provider", amountUsd: 48.0, memo: text.slice(0, 80) }, summary: "Pay $48.00 to Hosting provider", risk };
    case "send":
      return { tool: "send_email", title: "Send email to a client", input: { to: "client@example.com", subject: "Project update", body: text.slice(0, 200) }, summary: "Send email to client@example.com", risk };
    default:
      return { tool: "Bash", title: "Push to origin", input: { command: "git push origin HEAD" }, summary: "git push origin HEAD", risk };
  }
}

/**
 * Deterministic scripted agent (ARCHITECTURE.md 12.2). For each input text T:
 *  1. running; stream "Working on: T"            4. "?" in T → question approval, echo the answer
 *  2. Read tool call + result (auto-allowed)      5. /fail/ → failed
 *  3. deploy|delete|send|push|pay → approval      6. otherwise a canned result; succeeded
 */
export function createMockAdapter(opts: MockOptions = {}): AgentAdapter {
  const speed = opts.speed ?? 1;
  return {
    kind: "mock",
    start(ctx: RunContext): RunHandle {
      const queue: string[] = [ctx.run.prompt];
      const startedAt = Date.now();
      let turns = 0;

      const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) return reject(new Cancelled());
          const t = setTimeout(() => {
            ctx.signal.removeEventListener("abort", onAbort);
            resolve();
          }, Math.max(0, ms * speed));
          const onAbort = () => {
            clearTimeout(t);
            reject(new Cancelled());
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        });

      const tool = async (name: string, title: string, input: Record<string, unknown>, output: string) => {
        const toolUseId = newId("toolu");
        ctx.emit("tool_call", { toolUseId, tool: name, title, input });
        await sleep(350);
        ctx.emit("tool_result", { toolUseId, output, isError: false });
      };

      /** Returns "failed" when the turn ended the run in failure. */
      const turn = async (T: string): Promise<{ failed?: string; summary: string }> => {
        turns++;
        // 0a. the owner asked where the session stands: one answer, no tools
        if (T.startsWith(RECAP_PROMPT.slice(0, 40))) {
          await sleep(300);
          const recap = "**Doing:** scripted work in this session for the prototype.\n**Done:** every request so far has been answered.\n**Next:** nothing is waiting on you.";
          ctx.emit("text", { text: recap });
          return { summary: "Wrote a recap." };
        }
        // 0b. "security audit": a reply that uses toned text, so the rendering can be seen without a real agent
        if (/\bsecurity audit\b/i.test(T)) {
          await sleep(300);
          ctx.emit("text", { text: TONE_DEMO });
          return { summary: "Audit finished: 1 critical, 1 warning." };
        }
        // 1. streaming preamble over about two seconds
        const full = `Working on: ${T}`;
        const words = full.split(/(?<=\s)/);
        const step = 2000 / Math.max(words.length, 1);
        for (const w of words) {
          ctx.emit("text_delta", { text: w }, { persist: false });
          await sleep(Math.min(step, 220));
        }
        ctx.emit("text", { text: full });

        // 2. a read-only tool call, auto-allowed by policy
        const read = classify("Read", { file_path: "README.md" }, { cwd: ctx.run.cwd });
        await tool("Read", "Read project notes", { file_path: "README.md" }, `# ${ctx.run.cwd ?? "workspace"}\n(${read.reason}; 42 lines read)`);

        let outcome = "";
        // 3. a risky action waits for the owner
        const action = plannedAction(T);
        if (action) {
          const verdict = classify(action.tool, action.input, { cwd: ctx.run.cwd });
          const decision = await ctx.requestApproval({
            kind: "tool", tool: action.tool, title: action.title, summary: action.summary, input: action.input, risk: action.risk,
            reason: verdict.tier === "ask" ? verdict.reason : "Matches rule: outward action",
          });
          if (decision.decision === "approve") {
            await tool(action.tool, action.title, action.input, `${action.summary}\n✓ done (simulated)`);
            outcome = `${action.title}: done.`;
          } else {
            ctx.emit("text", { text: "Understood, I did not do that." });
            return { summary: `${action.title}: denied${decision.message ? ` ("${decision.message}")` : ""}. Nothing was changed.` };
          }
        }

        // 4. a question for the owner
        if (T.includes("?")) {
          const header = "Choice";
          const question = "Which option should I go with?";
          const decision = await ctx.requestApproval({
            kind: "question", title: "A quick question", risk: "low", reason: "The agent needs a decision to continue",
            questions: [{
              question, header, multiSelect: false,
              options: [{ label: "Option A", description: "The safer, slower path" }, { label: "Option B", description: "The faster path" }],
            }],
          });
          if (decision.decision === "approve") {
            const answer = decision.answers?.[question] ?? Object.values(decision.answers ?? {})[0] ?? "no answer";
            ctx.emit("text", { text: `You chose: ${answer}` });
            outcome = `${outcome} Went with ${answer}.`.trim();
          } else {
            ctx.emit("text", { text: "Understood, I did not do that." });
            return { summary: "Question dismissed. Nothing was changed." };
          }
        }

        // 5. scripted failure
        if (/fail/i.test(T)) {
          await sleep(300);
          ctx.emit("error", { message: "Simulated failure: the task asked me to fail." });
          return { failed: "Simulated failure: the task asked me to fail.", summary: "" };
        }

        // 6. canned result
        await sleep(300);
        const result = outcome ? `Done. ${outcome}` : `Done. I looked into "${T.slice(0, 120)}" and found nothing that needs your attention.`;
        ctx.emit("text", { text: result });
        return { summary: result };
      };

      const done = (async () => {
        try {
          ctx.status("running", { sessionRef: `mock-${ctx.run.id.slice(-12)}` });
          let last = { summary: "" } as { failed?: string; summary: string };
          while (queue.length) {
            last = await turn(queue.shift()!);
            if (last.failed) break;
            if (queue.length) ctx.status("running");
          }
          const durationMs = Date.now() - startedAt;
          if (last.failed) {
            ctx.status("failed", { error: last.failed, costUsd: 0, numTurns: turns, durationMs });
          } else {
            ctx.emit("result", { summary: last.summary });
            ctx.status("succeeded", { summary: last.summary, costUsd: 0, numTurns: turns, durationMs });
          }
        } catch (err) {
          if (err instanceof Cancelled || ctx.signal.aborted) {
            ctx.status("cancelled", { numTurns: turns, durationMs: Date.now() - startedAt });
          } else {
            const message = (err as Error).message ?? String(err);
            ctx.emit("error", { message });
            ctx.status("failed", { error: message, numTurns: turns, durationMs: Date.now() - startedAt });
          }
        }
      })();

      return {
        input: (text) => queue.push(text),
        cancel: () => {},
        done,
      };
    },
  };
}
