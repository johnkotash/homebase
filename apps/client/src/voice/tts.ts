import * as Speech from "expo-speech";
import { stripAgentMarkup } from "@homebase/protocol";

/** System text-to-speech (expo-speech; web uses speechSynthesis). */
export function speak(text: string, opts: { onDone?: () => void; rate?: number } = {}) {
  try {
    Speech.stop();
    // Toned text is read as its words, not as its markup.
    Speech.speak(stripAgentMarkup(text).replace(/[`*_#>]/g, "").slice(0, 3800), {
      language: "en-US", rate: opts.rate ?? 1.0, onDone: opts.onDone, onStopped: opts.onDone, onError: () => opts.onDone?.(),
    });
  } catch {
    opts.onDone?.();
  }
}

export function stopSpeaking() {
  try {
    Speech.stop();
  } catch {}
}
