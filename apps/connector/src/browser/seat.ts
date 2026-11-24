import type { BrowserSeat } from "@homebase/protocol";

/**
 * Who is driving the browser (docs/BROWSER-AGENT-PLAN.md 4.3). Exactly one party at a time.
 *
 * Taking over never needs the agent's cooperation: its next step simply waits here until the owner hands
 * the browser back. A step that is already under way (one click, one page load) finishes first.
 */
export class Seat {
  private current: BrowserSeat = "agent";
  private waiting = new Set<() => void>();
  needs: { reason: string; site: string | null; since: number } | null = null;

  constructor(private onChange: (seat: BrowserSeat, before: BrowserSeat) => void = () => {}, private now: () => number = Date.now) {}

  get state(): BrowserSeat {
    return this.current;
  }
  /** The owner's mouse and keys reach the page only in these two states. */
  get ownerDrives(): boolean {
    return this.current === "owner" || this.current === "signin";
  }
  /** Nothing is recorded while this is true: no pictures kept, no timeline, no log of what happened. */
  get isPrivate(): boolean {
    return this.current === "signin";
  }
  get waiters(): number {
    return this.waiting.size;
  }

  private set(next: BrowserSeat) {
    const before = this.current;
    if (next !== "needs_owner") this.needs = null;
    if (before === next) return;
    this.current = next;
    if (next === "agent") for (const w of [...this.waiting]) w();
    this.onChange(next, before);
  }

  /** The owner takes the wheel. */
  take() {
    this.set("owner");
  }
  /** The owner takes the wheel privately, to sign in. */
  signin() {
    this.set("signin");
  }
  /** The owner stops the agent without driving. */
  pause() {
    this.set("paused");
  }
  /** Back to the agent, from any state. */
  release() {
    this.set("agent");
  }
  /** The agent has hit something only a person may do. Ignored while the owner is already driving. */
  needOwner(reason: string, site: string | null): boolean {
    if (this.current !== "agent" && this.current !== "needs_owner") return false;
    this.needs = { reason, site, since: this.now() };
    const before = this.current;
    this.current = "needs_owner";
    this.onChange("needs_owner", before);
    return true;
  }
  /** The owner answered without taking the wheel: the agent goes on. */
  clearNeed() {
    if (this.current === "needs_owner") this.set("agent");
  }

  /**
   * Resolves when it is the agent's turn: at once when it is driving, otherwise when the owner hands the
   * browser back. `onWait` is called once if there is a wait, with the reason. Rejects when the run is cancelled.
   */
  agentTurn(signal?: AbortSignal, onWait?: (seat: BrowserSeat) => void): Promise<void> {
    if (this.current === "agent") return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error("cancelled"));
    onWait?.(this.current);
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        this.waiting.delete(done);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiting.delete(done);
        reject(new Error("cancelled"));
      };
      this.waiting.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
