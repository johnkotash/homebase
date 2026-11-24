/**
 * How dictated text lands in a text field. Pure, so the phone and the desktop share it and it can be
 * tested: live text while you talk, the final text when you stop, and the field as it was if you cancel.
 */
export interface DictationDraft {
  /** The field as it was when this dictation started. Cancel puts it back. */
  before: string;
  /** The text the next spoken words are added to: what was typed, plus what was already dictated. */
  base: string;
}

/** Adds spoken words after what is already there, with exactly one space between. */
export function joinTranscript(existing: string, spoken: string): string {
  const a = existing.trim(), b = spoken.trim();
  return a && b ? `${a} ${b}` : a || b;
}

export const beginDraft = (text: string): DictationDraft => ({ before: text, base: text });

/** The field while the words are still changing. */
export const draftPartial = (d: DictationDraft, partial: string): string => joinTranscript(d.base, partial);

/** The words are settled: they become part of the text the next utterance is added to. */
export function draftFinal(d: DictationDraft, final: string): { text: string; draft: DictationDraft } {
  const text = joinTranscript(d.base, final);
  return { text, draft: { before: d.before, base: text } };
}

/** The owner typed in the field: later words are added to what is there now. */
export const draftEdited = (d: DictationDraft, text: string): DictationDraft => ({ before: d.before, base: text });

/** Cancel: the field goes back to what it held before the dictation started. */
export const draftCancel = (d: DictationDraft): string => d.before;
