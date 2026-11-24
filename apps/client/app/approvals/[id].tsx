import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { inputText } from "../../src/components/ApprovalCard";
import { AgentAvatar, ConfirmDialog, RiskBadge, RunStatusChip } from "../../src/components/bits";
import { ApprovalsList, Placeholder } from "../../src/components/lists";
import { Markdown } from "../../src/components/Markdown";
import { ModeTag } from "../../src/components/ModeSwitch";
import { PlanActions, planOutcome, planText } from "../../src/components/PlanCard";
import { Btn, Card, Icon, SectionTitle, T, Tag } from "../../src/components/ui";
import { dayTime } from "../../src/format";
import { emailOfApproval, isGmailSend } from "../../src/gmail";
import { EmailFields } from "../../src/components/GmailCards";
import { Header, Screen, Split } from "../../src/layout/Shell";
import { useOne, useSync } from "../../src/sync/hooks";
import { mutate, syncStore } from "../../src/sync/session";
import { color, radius, riskColor, space, tint } from "../../src/theme";

function Detail({ id }: { id: string }) {
  const a = useOne("approvals", id);
  const agent = useSync((s) => (a?.agentId ? s.entities.agents[a.agentId] : undefined));
  const run = useSync((s) => (a ? s.entities.runs[a.runId] : undefined));
  const decider = useSync((s) => (a?.decidedBy ? s.entities.devices[a.decidedBy] : undefined));
  const [message, setMessage] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!a) return <Placeholder icon="shield" title="Approval not found" />;
  const pending = a.status === "pending";
  const tone = riskColor[a.risk];
  const question = a.kind === "question";
  const plan = a.kind === "plan";
  const email = a.kind === "tool" ? emailOfApproval(a) : null;
  const sending = isGmailSend(a);
  const allAnswered = !question || (a.questions ?? []).every((q) => answers[q.question]);

  const decide = async (decision: "approve" | "deny", biometricAt?: number) => {
    setBusy(true);
    await mutate("approval.decide", { approvalId: a.id, decision, message: message.trim() || null, answers: question && decision === "approve" ? answers : null, biometricAt });
    setBusy(false);
  };
  const approve = () => (a.risk === "high" ? setConfirming(true) : void decide("approve"));

  return (
    <Screen>
      <Header title={question ? "Question" : plan ? "Plan" : "Approval"} subtitle={`Requested ${dayTime(a.requestedAt)}`} back="/approvals" />
      <View style={[st.hero, { borderColor: tint(tone, 0.45), backgroundColor: tint(tone, 0.06) }]}>
        <View style={st.h}>
          {plan ? null : <RiskBadge risk={a.risk} />}
          {a.mode ? <ModeTag mode={plan ? "plan" : a.mode} /> : null}
          {pending ? <Tag label="WAITING FOR YOU" tone={color.p1} icon="pause-circle" /> : (
            <Tag label={a.status.toUpperCase()} tone={a.status === "approved" ? color.ok : a.status === "denied" ? color.danger : color.textMuted} />
          )}
        </View>
        <T v="display" style={{ fontSize: 26, lineHeight: 31 }} selectable>{a.title}</T>
        {a.reason ? <View style={st.h}><Icon name="info" size={14} /><T v="small" style={{ flex: 1 }}>{a.reason}</T></View> : null}
      </View>

      <Card onPress={() => router.navigate(`/runs/${a.runId}` as any)} pad={space.md} style={{ marginTop: space.md }}>
        <View style={[st.h, { gap: space.md }]}>
          <AgentAvatar name={agent?.name ?? "Agent"} online={agent?.status === "online"} size={38} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <T v="heading" style={{ fontSize: 15 }}>{agent?.name ?? "Agent"}</T>
            <T v="small" numberOfLines={1}>{run?.prompt ?? "Run"}</T>
          </View>
          {run ? <RunStatusChip status={run.status} /> : null}
          <Icon name="chevron-right" />
        </View>
      </Card>

      {plan ? (
        <>
          <SectionTitle title="Proposed plan" />
          <View style={st.code} testID="plan-body"><Markdown text={planText(a) || "(The agent sent an empty plan.)"} selectable /></View>
          {pending ? <View style={{ marginTop: space.lg }}><PlanActions approval={a} /></View> : null}
        </>
      ) : question ? (
        (a.questions ?? []).map((q) => (
          <View key={q.question}>
            <SectionTitle title={q.header ?? "Question"} />
            <T v="heading" style={{ marginBottom: space.sm }}>{q.question}</T>
            <View style={{ gap: space.sm }}>
              {q.options.map((o) => {
                const chosen = (pending ? answers[q.question] : a.answers?.[q.question]) === o.label;
                return (
                  <Pressable key={o.label} disabled={!pending} onPress={() => setAnswers({ ...answers, [q.question]: o.label })}
                    accessibilityRole="radio" accessibilityState={{ selected: chosen }} accessibilityLabel={o.label}
                    style={[st.option, chosen && { borderColor: color.accent, backgroundColor: color.accentDim }]}>
                    <View style={[st.radio, chosen && { borderColor: color.accent }]}>{chosen ? <View style={st.radioDot} /> : null}</View>
                    <View style={{ flex: 1 }}><T v="heading" style={{ fontSize: 15 }}>{o.label}</T>{o.description ? <T v="small">{o.description}</T> : null}</View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))
      ) : email ? (
        <>
          <SectionTitle title={sending ? "Email to send" : "Draft to save in Gmail"} />
          <EmailFields email={email} />
          {sending ? <T v="small" muted style={{ marginTop: space.sm }}>Read back from Gmail by the connector, not taken from the agent. If the draft changes after you approve, it is not sent.</T> : null}
        </>
      ) : (
        <>
          <SectionTitle title={`Exact input${a.tool ? ` · ${a.tool}` : ""}`} />
          <View style={st.code}><T v="mono" selectable style={{ fontSize: 14, lineHeight: 21 }}>{inputText(a) || "(no input)"}</T></View>
        </>
      )}

      {pending && plan ? null : pending ? (
        <>
          <SectionTitle title="Message to the agent (optional)" />
          <TextInput value={message} onChangeText={setMessage} placeholder={question ? "Add context for your answer" : "Why, or what to do instead"} placeholderTextColor={color.textMuted}
            style={st.input} multiline accessibilityLabel="Message to the agent" />
          {a.risk === "high" ? (
            <View style={[st.h, { marginTop: space.md }]}><Icon name="lock" size={14} tone={color.p0} /><T v="small" style={{ flex: 1 }}>High risk: approving asks you to confirm on this device. It cannot be approved from a notification or by voice.</T></View>
          ) : null}
          <View style={st.actions}>
            <Btn label={question ? "Dismiss" : "Deny"} kind="danger" icon="x" onPress={() => void decide("deny")} busy={busy} grow testID="deny" />
            <Btn label={question ? "Send answer" : sending ? "Send email" : "Approve"} kind="primary" icon="check" onPress={approve} disabled={!allAnswered} busy={busy} grow testID="approve" />
          </View>
        </>
      ) : (
        <Card style={{ marginTop: space.lg, gap: 6 }}>
          <T v="micro">Decision</T>
          <T>
            {plan ? planOutcome(a) : a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : a.status === "expired" ? "Expired: the connector lost the run" : "Cancelled: the run ended first"}
            {a.decidedAt ? ` · ${dayTime(a.decidedAt)}` : ""}{decider ? ` · on ${decider.name}` : ""}
          </T>
          {a.decisionMessage ? <T v="small">“{a.decisionMessage}”</T> : null}
          <T v="small" muted>Recorded in the audit log.</T>
        </Card>
      )}

      <ConfirmDialog
        visible={confirming}
        title="Confirm it's you"
        body={sending ? "The email is sent from your Gmail account as soon as you confirm. It cannot be unsent. This stands in for the fingerprint check."
          : `${agent?.name ?? "The agent"} will run this as soon as you confirm. This stands in for the fingerprint check.`}
        detail={inputText(a)}
        confirmLabel={sending ? "Send" : "Approve"}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          // The hub checks biometricAt against its own clock, so send hub time.
          void decide("approve", Date.now() + syncStore.getState().clockOffset);
        }}
      />
    </Screen>
  );
}

export default function ApprovalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Split show="detail" list={<ApprovalsList selectedId={id} />} detail={<Detail id={id} key={id} />} />;
}

const st = StyleSheet.create({
  h: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  hero: { borderWidth: 1, borderRadius: radius.xl, padding: space.lg, gap: space.md, marginTop: space.sm },
  code: { backgroundColor: color.surface, borderRadius: radius.lg, padding: space.lg, borderWidth: 1, borderColor: color.borderStrong },
  input: {
    minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface, color: color.text, fontSize: 15,
    paddingHorizontal: space.lg, paddingVertical: space.md, outlineStyle: "none",
  } as any,
  actions: { flexDirection: "row", gap: space.md, marginTop: space.xl },
  option: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 60, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.borderStrong, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.accent },
});
