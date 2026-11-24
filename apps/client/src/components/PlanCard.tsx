import React, { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { Approval } from "@homebase/protocol";
import { MODE } from "../modes";
import { useSync } from "../sync/hooks";
import { mutate } from "../sync/session";
import { color, radius, space } from "../theme";
import { Btn, Icon, T } from "./ui";

export const planText = (a: Approval): string => {
  const i = a.input as { plan?: unknown } | null;
  return typeof i?.plan === "string" && i.plan.trim() ? i.plan : a.summary ?? "";
};

/** How a decided plan reads: which mode it was approved into, or that it was sent back. */
export function planOutcome(a: Approval): string {
  if (a.status === "approved") return `Approved · running in ${a.mode && a.mode !== "plan" ? MODE[a.mode].label : "Manual"}`;
  if (a.status === "denied") return "Sent back to keep planning";
  if (a.status === "expired") return "Expired: the connector lost the run";
  return "Cancelled: the run ended first";
}

/**
 * The three things an owner can do with a plan: run it in Auto, run it in Manual, or send it back
 * with a note. Approving switches the run and its chat to the chosen mode.
 */
export function PlanActions({ approval: a }: { approval: Approval }) {
  const agent = useSync((s) => (a.agentId ? s.entities.agents[a.agentId] : undefined));
  const [revising, setRevising] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const canAuto = !agent?.modes || agent.modes.includes("auto");
  const decide = async (key: string, args: { decision: "approve" | "deny"; mode?: "auto" | "manual"; message?: string | null }) => {
    setBusy(key);
    await mutate("approval.decide", { approvalId: a.id, ...args });
    setBusy(null);
  };
  if (revising) {
    return (
      <View style={{ gap: space.sm }}>
        <TextInput value={message} onChangeText={setMessage} autoFocus multiline placeholder="What should change in the plan?" placeholderTextColor={color.textMuted}
          style={st.input} accessibilityLabel="Message to the agent about the plan" testID="plan-message" />
        <View style={st.row}>
          <Btn label="Back" kind="ghost" onPress={() => setRevising(false)} />
          <Btn label="Send & keep planning" kind="primary" icon="corner-up-left" grow busy={busy === "keep"} disabled={!message.trim() || !!busy}
            onPress={() => void decide("keep", { decision: "deny", message: message.trim() })} testID="plan-keep-send" />
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap: space.sm }}>
      {canAuto ? (
        <Btn label="Approve & run in Auto" kind="primary" icon="zap" busy={busy === "auto"} disabled={!!busy}
          onPress={() => void decide("auto", { decision: "approve", mode: "auto" })} testID="plan-approve-auto" />
      ) : null}
      <Btn label="Approve & run in Manual" kind={canAuto ? "secondary" : "primary"} icon="shield" busy={busy === "manual"} disabled={!!busy}
        onPress={() => void decide("manual", { decision: "approve", mode: "manual" })} testID="plan-approve-manual" />
      <Btn label="Keep planning" kind="ghost" icon="corner-up-left" disabled={!!busy} onPress={() => setRevising(true)} testID="plan-keep" />
      <View style={st.hint}>
        <Icon name="info" size={12} tone={color.textMuted} />
        <T v="small" muted style={{ flex: 1, fontSize: 12 }}>Nothing has been changed yet. Approving switches this chat to the mode you pick.</T>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", gap: space.sm },
  hint: { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  input: {
    minHeight: 76, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg, color: color.text, fontSize: 15,
    lineHeight: 21, padding: space.md, textAlignVertical: "top", outlineStyle: "none",
  } as any,
});
