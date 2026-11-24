import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/voice/grammar";

describe("driving-mode voice grammar", () => {
  it("matches the fixed commands regardless of case and trailing punctuation", () => {
    expect(parseCommand("Next.")).toEqual({ cmd: "next" });
    expect(parseCommand("repeat")).toEqual({ cmd: "repeat" });
    expect(parseCommand("Approve!")).toEqual({ cmd: "approve" });
    expect(parseCommand("deny")).toEqual({ cmd: "deny" });
    expect(parseCommand("Snooze")).toEqual({ cmd: "snooze" });
    expect(parseCommand(" stop ")).toEqual({ cmd: "stop" });
  });

  it("captures the text after reply and note", () => {
    expect(parseCommand("Reply I'll call you at five")).toEqual({ cmd: "reply", text: "I'll call you at five" });
    expect(parseCommand("note: ask Marcus for the API key")).toEqual({ cmd: "note", text: "ask Marcus for the API key" });
  });

  it("does not treat ordinary speech as a command", () => {
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("what is next on my calendar")).toBeNull();
    expect(parseCommand("I would not approve that")).toBeNull(); // approval needs the bare word
    expect(parseCommand("reply")).toBeNull();
    expect(parseCommand("notebook")).toBeNull();
  });
});
