import type { Approval, Question } from "@homebase/protocol";

/**
 * A question that can be answered with one tap, right on its card: an agent (or HomeBase itself, when it is
 * unclear who should make an image) asks one thing with two to four choices. Anything more involved, such as
 * several questions or a pick-many, opens the full screen as before.
 */
export function quickQuestion(a: Pick<Approval, "kind" | "status" | "questions" | "risk">): Question | null {
  if (a.kind !== "question" || a.status !== "pending" || a.risk === "high") return null;
  const qs = a.questions ?? [];
  if (qs.length !== 1 || qs[0].multiSelect) return null;
  return qs[0].options.length >= 2 ? qs[0] : null;
}

/** The `answers` a one-tap choice sends: the question's own text as the key, the tapped label as the value. */
export const quickAnswer = (q: Pick<Question, "question">, label: string): Record<string, string> => ({ [q.question]: label });
