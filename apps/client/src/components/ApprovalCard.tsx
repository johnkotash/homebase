import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Approval } from "@homebase/protocol";
import { BROWSER_APPROVAL, isBrowserApproval } from "@homebase/protocol";
import { ago } from "../format";
import { emailOfApproval, isGmailSend } from "../gmail";
import { quickAnswer, quickQuestion } from "../questions";
import { openBrowser } from "./BrowserPanel";
import { EmailFields } from "./GmailCards";
import { useSync } from "../sync/hooks";
import { mutate } from "../sync/session";
import { color, radius, riskColor, space } from "../theme";
import { RiskBadge, approvalNeedsReview } from "./bits";
import { Markdown } from "./Markdown";
import { ModeTag } from "./ModeSwitch";
import { PlanActions, planOutcome, planText } from "./PlanCard";
import { Btn, Card, Icon, T, Tag } from "./ui";

export function inputText(a: Approval): string {
  const i = a.input as any;
  const email = emailOfApproval(a);
  if (email) return [`To: ${[...email.to, ...email.cc, ...email.bcc].join(", ") || "(none)"}`, `Subject: ${email.subject || "(no subject)"}`].join("\n");
  // A step in the browser: what would be pressed or typed and where, in words, as the browser itself read it from the page.
  if (isBrowserApproval(a.tool) && i && typeof i === "object") {
    return [
      i.target ? `${String(i.action ?? "act on")} ${String(i.target)}` : null, i.text != null ? `Text: ${String(i.text)}` : null,
      a.tool === BROWSER_APPROVAL.needsOwner ? a.summary : null, i.page ? `Page: ${String(i.page)}` : null, i.sendsTo ? `Sends to: ${String(i.sendsTo)}` : null,
    ].filter(Boolean).join("\n");
  }
  if (i == null) return a.summary ?? "";
  if (typeof i === "string") return i;
  if (typeof i.command === "string") return i.command;
  return JSON.stringify(i, null, 2);
}

/**
 * The approval control lives on the card itself, not three taps deep.
 * Low and medium risk decide inline, and so does a single question with a few choices (one tap on a choice).
 * High risk, and a question with several parts, open the detail screen.
 */
export function ApprovalCard({ approval: a, now, compact }: { approval: Approval; now: number; compact?: boolean }) {
  const agent = useSync((s) => (a.agentId ? s.entities.agents[a.agentId] : undefined));
  const runThread = useSync((s) => (a.runId ? s.entities.runs[a.runId]?.threadId ?? null : null));
  const pending = a.status === "pending";
  const review = approvalNeedsReview(a);
  const open = () => router.navigate(`/approvals/${a.id}` as any);
  const when = ago(a.requestedAt, now) === "now" ? "just now" : `${ago(a.requestedAt, now)} ago`;
  const email = a.kind === "tool" ? emailOfApproval(a) : null;
  if (a.kind === "plan") {
    // A plan is shown rendered, with its three choices on the card. Long plans are clipped here and open in full.
    const plan = planText(a);
    const long = plan.length > 900 || plan.split("\n").length > 18;
    return (
      <Card tone={pending ? color.accent : undefined} pad={space.md} style={{ gap: space.sm }}>
        <View style={st.head}>
          <Icon name="map" size={16} tone={pending ? color.text : color.textMuted} />
          <T v="small" style={{ flex: 1 }} numberOfLines={1}>{agent?.name ?? "Agent"} · {when}</T>
          <ModeTag mode="plan" />
        </View>
        <T v="heading">{pending ? "Plan ready for your review" : "Plan"}</T>
        <View style={[st.plan, (compact || long) && { maxHeight: compact ? 120 : 320 }]} testID="plan-body">
          <Markdown text={plan || "(The agent sent an empty plan.)"} />
        </View>
        {compact || long ? <Btn small kind="ghost" icon="maximize-2" label="Open the full plan" onPress={open} /> : null}
        {pending ? (compact ? null : <PlanActions approval={a} />) : (
          <Tag label={planOutcome(a).toUpperCase()} tone={a.status === "approved" ? color.ok : color.textMuted} icon={a.status === "approved" ? "check" : a.status === "denied" ? "corner-up-left" : "minus"} />
        )}
      </Card>
    );
  }
  // One question with a few choices is answered on the card: each choice is a button, and one tap sends it.
  // The same card on the phone and the desktop. (Several questions, or a pick-many, still open the full screen.)
  const quick = quickQuestion(a);
  if (quick) {
    return (
      <Card tone={riskColor[a.risk]} pad={space.md} style={{ gap: space.sm }}>
        <View style={st.head}>
          <Icon name="help-circle" size={16} tone={riskColor[a.risk]} />
          {/* The question about who makes an image comes from HomeBase's own routing rule, not from the agent. */}
          <T v="small" style={{ flex: 1 }} numberOfLines={1}>{(a.input as any)?.imageChoice ? "HomeBase asks" : `${agent?.name ?? "Agent"} asks`} · {when}</T>
        </View>
        <T v="heading">{quick.question}</T>
        {a.summary ? <T v="small" numberOfLines={compact ? 2 : 3}>“{a.summary}”</T> : null}
        {a.reason ? <T v="small" muted>{a.reason}</T> : null}
        <View style={{ gap: 6 }} testID="quick-answers">
          {quick.options.map((o, i) => (
            <Pressable key={o.label} accessibilityRole="button" accessibilityLabel={o.description ? `${o.label}. ${o.description}` : o.label} testID={`quick-answer-${i}`}
              onPress={() => void mutate("approval.decide", { approvalId: a.id, decision: "approve", answers: quickAnswer(quick, o.label) })}
              style={({ pressed, hovered }: any) => [st.answer, hovered && { backgroundColor: color.surface3, borderColor: color.accent }, pressed && { opacity: 0.75 }]}>
              <View style={{ flex: 1, gap: 1 }}>
                <T v="heading" style={{ fontSize: 15 }}>{o.label}</T>
                {o.description && !compact ? <T v="small">{o.description}</T> : null}
              </View>
              <Icon name="arrow-right" size={16} tone={color.text} />
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Btn small kind="ghost" icon="x" label="Dismiss" onPress={() => void mutate("approval.decide", { approvalId: a.id, decision: "deny" })} testID="quick-dismiss" />
          <Btn small kind="ghost" icon="maximize-2" label="Open" onPress={open} />
        </View>
      </Card>
    );
  }
  return (
    <Card tone={pending ? riskColor[a.risk] : undefined} onPress={open} pad={space.md} style={{ gap: space.sm }}>
      <View style={st.head}>
        <Icon name={a.kind === "question" ? "help-circle" : email ? (isGmailSend(a) ? "send" : "file-text") : "shield"} size={16} tone={pending ? riskColor[a.risk] : color.textMuted} />
        <T v="small" style={{ flex: 1 }} numberOfLines={1}>{(a.input as any)?.imageChoice ? "HomeBase" : agent?.name ?? "Agent"} · {when}</T>
        {a.mode ? <ModeTag mode={a.mode} /> : null}
        <RiskBadge risk={a.risk} />
      </View>
      <T v="heading">{a.kind === "question" ? a.questions?.[0]?.question ?? a.title : a.title}</T>
      {email ? <EmailFields email={email} maxBodyLines={compact ? 3 : 8} /> : a.kind === "tool" && inputText(a) ? (
        <View style={st.code}><T v="mono" numberOfLines={compact ? 2 : 4}>{inputText(a)}</T></View>
      ) : null}
      {pending && a.mode === "auto" && a.reason ? <T v="small" muted>{a.reason}</T> : null}
      {/* A browser step is easier to judge with the page in view; a "needs you" card is answered there, by hand. */}
      {pending && isBrowserApproval(a.tool) && agent?.connectorId ? (
        <Btn small kind="ghost" icon="globe" label={a.tool === BROWSER_APPROVAL.needsOwner ? "Open the browser and take over" : "See the page"} testID="approval-open-browser"
          onPress={() => openBrowser(agent.connectorId!, { threadId: runThread })} />
      ) : null}
      {pending ? (
        review ? (
          <Btn label={a.kind === "question" ? "Answer" : email ? "Review and send — needs your hands" : "Review — needs your hands"} icon={a.kind === "question" ? "message-circle" : "lock"} onPress={open} kind="secondary" />
        ) : (
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Btn label="Deny" kind="danger" icon="x" grow onPress={() => void mutate("approval.decide", { approvalId: a.id, decision: "deny" })} />
            <Btn label="Approve" kind="primary" icon="check" grow onPress={() => void mutate("approval.decide", { approvalId: a.id, decision: "approve" })} />
          </View>
        )
      ) : (
        <Tag
          label={a.status === "approved" && a.kind === "question" ? `ANSWERED: ${Object.values(a.answers ?? {})[0] ?? ""}` : a.status.toUpperCase()}
          tone={a.status === "approved" ? color.ok : a.status === "denied" ? color.danger : color.textMuted}
          icon={a.status === "approved" ? "check" : a.status === "denied" ? "x" : "minus"}
        />
      )}
    </Card>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  code: { backgroundColor: color.bg, borderRadius: radius.sm, padding: space.md, borderWidth: 1, borderColor: color.border },
  plan: { backgroundColor: color.bg, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.border, overflow: "hidden" },
  answer: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52, paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface2 },
});
