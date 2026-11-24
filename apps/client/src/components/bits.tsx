import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import type { Approval, InboxItem, InboxSource, Priority, Risk, RunStatus } from "@homebase/protocol";
import { RUN_STATUS, SOURCE, slaView } from "../format";
import { reconnectNow, useSession } from "../sync/session";
import { router } from "expo-router";
import { useDesktopConnection } from "../desktop/connection";
import { connectionHeadline } from "../desktop/connectionRules";
import { useSync } from "../sync/hooks";
import { color, priorityColor, radius, riskColor, space, tint } from "../theme";
import { Btn, Dot, Icon, T, Tag } from "./ui";

export function PriorityChip({ priority, solid }: { priority: Priority; solid?: boolean }) {
  return <Tag label={priority} tone={priorityColor[priority]} solid={solid ?? priority === "P0"} />;
}

export function RiskBadge({ risk }: { risk: Risk }) {
  return <Tag label={`${risk.toUpperCase()} RISK`} tone={riskColor[risk]} icon={risk === "high" ? "alert-triangle" : "shield"} />;
}

export function SourceIcon({ source, size = 36 }: { source: InboxSource; size?: number }) {
  const m = SOURCE[source];
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: tint(m.tone, 0.13), alignItems: "center", justifyContent: "center" }}>
      <Icon name={m.icon} size={size * 0.47} tone={m.tone} />
    </View>
  );
}

/** Countdown to the response deadline. Green, amber past the warning point, red when overdue. */
export function SlaCountdown({ item, now, long }: { item: InboxItem; now: number; long?: boolean }) {
  const v = slaView(item, now);
  if (!v) return null;
  return (
    <View style={[st.sla, { backgroundColor: tint(v.tone, 0.12) }]}>
      <Icon name={v.state === "met" ? "check" : "clock"} size={11} tone={v.tone} />
      <T v="small" tone={v.tone} style={st.slaText}>{long ? v.label : v.short}</T>
    </View>
  );
}

export function RunStatusChip({ status }: { status: RunStatus }) {
  const m = RUN_STATUS[status];
  return <Tag label={m.label} tone={m.tone} icon={m.icon} />;
}

export function AgentAvatar({ name, online, size = 40 }: { name: string; online?: boolean; size?: number }) {
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return (
    <View style={{ width: size, height: size }}>
      <View style={[st.avatar, { width: size, height: size, borderRadius: size * 0.32 }]}>
        <T v="heading" tone={color.accent} style={{ fontSize: size * 0.36 }}>{initials}</T>
      </View>
      {online != null ? <Dot tone={online ? color.ok : color.textMuted} size={11} style={st.presence} /> : null}
    </View>
  );
}

/** Persistent connection state: online, reconnecting, offline — N changes queued. */
export function ConnectionBanner() {
  const status = useSync((s) => s.status);
  const queued = useSync((s) => s.outbox.length);
  const paired = useSession((s) => !!s.session);
  const desktopConn = useDesktopConnection((s) => s.snap);
  if (!paired) return null;
  const m: { tone: string; text: string } =
    status === "online" ? { tone: color.ok, text: queued ? `Online · sending ${queued} change${queued === 1 ? "" : "s"}` : "Online · live" }
    : status === "offline" ? { tone: color.danger, text: `Offline — ${queued} change${queued === 1 ? "" : "s"} queued` }
    : status === "unauthorized" ? { tone: color.danger, text: "This device was unpaired" }
    : { tone: color.warn, text: queued ? `Reconnecting… ${queued} change${queued === 1 ? "" : "s"} queued` : status === "connecting" || status === "idle" ? "Connecting…" : "Reconnecting…" };
  const calm = status === "online";
  // Installed desktop app: while its tunnel (or direct address) is down, say that, and a click opens the setting.
  const tunnelDown = !calm && desktopConn && desktopConn.state.phase !== "connected";
  if (tunnelDown) m.text = `${m.text} · ${connectionHeadline(desktopConn, Date.now()).title}`;
  return (
    <Pressable
      accessibilityRole="text"
      accessibilityLabel={`Connection: ${m.text}`}
      testID="connection-banner"
      onPress={calm ? undefined : tunnelDown ? () => router.push("/connection") : reconnectNow}
      style={[st.banner, { backgroundColor: calm ? "transparent" : tint(m.tone, 0.14), borderBottomColor: calm ? color.border : tint(m.tone, 0.4) }]}
    >
      <Dot tone={m.tone} size={7} />
      <T v="small" tone={calm ? color.textMuted : m.tone} style={{ fontSize: 12 }}>{m.text}</T>
    </Pressable>
  );
}

/** Stand-in for the biometric gate on high-risk approvals (expo-local-authentication at MVP). */
export function ConfirmDialog({ visible, title, body, detail, confirmLabel, onConfirm, onCancel, tone = color.danger }: {
  visible: boolean; title: string; body: string; detail?: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; tone?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!visible) return setArmed(false);
    const t = setTimeout(() => setArmed(true), 700); // no accidental double-tap through
    return () => clearTimeout(t);
  }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={st.scrim}>
        <View style={[st.dialog, { borderColor: tint(tone, 0.5) }]} accessibilityViewIsModal>
          <View style={[st.dialogIcon, { backgroundColor: tint(tone, 0.14) }]}><Icon name="lock" size={22} tone={tone} /></View>
          <T v="title" style={{ textAlign: "center" }}>{title}</T>
          <T v="small" style={{ textAlign: "center" }}>{body}</T>
          {detail ? <View style={st.dialogDetail}><T v="mono">{detail}</T></View> : null}
          <View style={{ flexDirection: "row", gap: space.md, alignSelf: "stretch", marginTop: space.sm }}>
            <Btn label="Cancel" onPress={onCancel} grow />
            <Btn label={confirmLabel} kind="danger" icon="check" onPress={onConfirm} disabled={!armed} grow testID="confirm-high-risk" />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export const approvalNeedsReview = (a: Approval) => a.risk === "high" || a.kind === "question" || a.kind === "plan";

const st = StyleSheet.create({
  sla: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, height: 22, borderRadius: 6, alignSelf: "flex-start" },
  slaText: { fontSize: 12, fontFamily: "SpaceGrotesk_500Medium", fontVariant: ["tabular-nums"] },
  avatar: { backgroundColor: color.accentDim, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: tint(color.accent, 0.25) },
  presence: { position: "absolute", right: -2, bottom: -2, borderWidth: 2, borderColor: color.surface },
  banner: { height: 26, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderBottomWidth: StyleSheet.hairlineWidth },
  scrim: { flex: 1, backgroundColor: color.overlay, alignItems: "center", justifyContent: "center", padding: space.xl },
  dialog: { width: "100%", maxWidth: 420, backgroundColor: color.surface, borderRadius: radius.xl, borderWidth: 1, padding: space.xl, alignItems: "center", gap: space.md },
  dialogIcon: { width: 54, height: 54, borderRadius: 27, alignItems: "center", justifyContent: "center" },
  dialogDetail: { alignSelf: "stretch", backgroundColor: color.bg, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.border },
});
