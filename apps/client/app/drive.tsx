import { useKeepAwake } from "expo-keep-awake";
import { Redirect, router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { newId, type Approval, type InboxItem } from "@homebase/protocol";
import { PriorityChip, RiskBadge } from "../src/components/bits";
import { MicButton } from "../src/components/MicButton";
import { saveCapture } from "../src/components/QuickCapture";
import { Icon, IconBtn, T, type IconName } from "../src/components/ui";
import { SOURCE, senderName } from "../src/format";
import { features } from "../src/platform";
import { byUrgency, isOpen, useList, useMap, useNow, usePendingApprovals } from "../src/sync/hooks";
import { mutate } from "../src/sync/session";
import { color, radius, riskColor, space, tint } from "../src/theme";
import { parseCommand } from "../src/voice/grammar";
import { speak, stopSpeaking } from "../src/voice/tts";
import { useDictation } from "../src/voice/useDictation";

type QueueItem = { key: string; kind: "approval"; approval: Approval } | { key: string; kind: "inbox"; item: InboxItem };

/**
 * Driving mode is for the phone. The desktop window and the browser have no entry to it, and a link
 * or an old bookmark to /drive lands on Home there, so its wake lock, speech and listening never start.
 */
export default function DriveRoute() {
  if (!features.drivingMode) return <Redirect href="/" />;
  return <DrivingMode />;
}

/** Full-screen, three large targets. Walks the queue in order: pending approvals, then P0, then P1. */
function DrivingMode() {
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const now = useNow();
  const approvals = usePendingApprovals();
  const items = useList("inbox_items");
  const agents = useMap("agents");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [said, setSaid] = useState("");
  const [heard, setHeard] = useState("");
  const [speaking, setSpeaking] = useState(false);

  const queue = useMemo<QueueItem[]>(() => {
    const open = items.filter(isOpen).sort(byUrgency);
    const q: QueueItem[] = [
      ...approvals.map((a) => ({ key: a.id, kind: "approval" as const, approval: a })),
      ...open.filter((i) => i.priority === "P0").map((i) => ({ key: i.id, kind: "inbox" as const, item: i })),
      ...open.filter((i) => i.priority === "P1").map((i) => ({ key: i.id, kind: "inbox" as const, item: i })),
    ];
    // Skipped items go to the back; a high-risk approval stays at the top (it needs hands).
    return [...q.filter((x) => !skipped.includes(x.key)), ...q.filter((x) => skipped.includes(x.key))];
  }, [approvals, items, skipped]);
  const current = queue[0];

  /** "source, sender, one-line summary, what is being asked" */
  const script = useCallback((q: QueueItem | undefined): string => {
    if (!q) return "Your queue is clear. Nothing needs you right now.";
    if (q.kind === "approval") {
      const a = q.approval;
      const who = (a.agentId && agents[a.agentId]?.name) || "An agent";
      if (a.kind === "plan") return `${who} has a plan to review. This one needs your hands; I've kept it at the top.`;
      if (a.kind === "question") return `Question from ${who}. ${a.questions?.[0]?.question ?? a.title}. This one needs your hands; I've kept it at the top.`;
      if (a.risk === "high") return `Approval from ${who}. ${a.title}. High risk. This one needs your hands; I've kept it at the top.`;
      return `Approval from ${who}. ${a.title}. ${a.risk} risk. Approve ${a.title.toLowerCase()}? Say approve or deny.`;
    }
    const i = q.item;
    const parts = [`${i.priority === "P0" ? "Urgent" : "Today"}, from ${SOURCE[i.source].label}`, senderName(i.sender) ? `sent by ${senderName(i.sender)}` : "", i.title, i.snippet ?? ""];
    return `${parts.filter(Boolean).map((p) => p.replace(/[.!?\s]+$/, "")).join(". ")}. Say next, snooze, or reply.`;
  }, [agents]);

  const say = useCallback((text: string) => {
    setSaid(text);
    setSpeaking(true);
    speak(text, { onDone: () => setSpeaking(false) });
  }, []);

  // Read each item aloud as it reaches the top of the queue.
  const lastRead = useRef<string | null>(null);
  useEffect(() => {
    const key = current?.key ?? "empty";
    if (lastRead.current === key) return;
    lastRead.current = key;
    say(script(current));
  }, [current?.key, say, script]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopSpeaking(), []);

  const next = useCallback(() => {
    if (!current) return say(script(undefined));
    if (queue.length === 1) return say(`That's the only item. ${script(current)}`);
    setSkipped((s) => [...s.filter((k) => k !== current.key), current.key]);
  }, [current, queue.length, say, script]);
  const repeat = useCallback(() => say(script(current)), [current, say, script]);
  const exit = () => {
    stopSpeaking();
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const onCommand = (transcript: string) => {
    setHeard(transcript);
    const c = parseCommand(transcript);
    if (!c) return say(`I heard: ${transcript}. I didn't catch a command. Say next, repeat, approve, deny, snooze, reply, note, or stop.`);
    switch (c.cmd) {
      case "next": return next();
      case "repeat": return repeat();
      case "stop": return exit();
      case "note":
        saveCapture("note", c.text, "voice");
        return say("Sent to today's note.");
      case "approve":
      case "deny": {
        if (current?.kind !== "approval") return say("There's no approval in front of you.");
        const a = current.approval;
        // Voice alone never decides a high-risk action or a question.
        if (a.risk === "high" || a.kind !== "tool") return say("This one needs your hands; I've kept it at the top.");
        void mutate("approval.decide", { approvalId: a.id, decision: c.cmd });
        return say(c.cmd === "approve" ? "Approved." : "Denied.");
      }
      case "snooze":
        if (current?.kind !== "inbox") return say("Only inbox items can be snoozed.");
        void mutate("inbox.update", { itemId: current.item.id, status: "snoozed", snoozeUntil: now + 3_600_000 });
        return say("Snoozed for one hour. The deadline keeps running.");
      case "reply":
        if (current?.kind !== "inbox") return say("There's nothing to reply to.");
        saveCapture("note", `Reply draft for "${current.item.title}": ${c.text}`, "voice");
        void mutate("inbox.update", { itemId: current.item.id, status: "in_progress" });
        return say("Saved your reply in today's note. Nothing was sent.");
    }
  };

  const d = useDictation({ mode: "handsfree", onPartial: setHeard, onFinal: onCommand });
  const talk = () => {
    stopSpeaking();
    setSpeaking(false);
    setHeard("");
    void d.start();
  };

  const tone = current?.kind === "approval" ? riskColor[current.approval.risk] : current ? (current.item.priority === "P0" ? color.p0 : color.p1) : color.ok;
  const Big = ({ label, icon, onPress, primary }: { label: string; icon: IconName; onPress: () => void; primary?: boolean }) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={`drive-${label.toLowerCase()}`}
      style={({ pressed }) => [st.big, primary && { backgroundColor: color.accent, borderColor: color.accent }, pressed && { opacity: 0.75, transform: [{ scale: 0.98 }] }]}>
      <Icon name={icon} size={34} tone={primary ? color.accentInk : color.text} />
      <T v="title" tone={primary ? color.accentInk : color.text} style={{ fontSize: 22 }}>{label}</T>
    </Pressable>
  );

  return (
    <View style={[st.root, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
      <View style={st.top}>
        <View style={st.h}><Icon name="navigation" tone={color.accent} /><T v="micro" tone={color.accent}>Driving mode</T></View>
        <T v="small" muted>{queue.length ? `1 of ${queue.length}` : "Queue clear"}</T>
        <IconBtn icon="x" label="Exit driving mode" onPress={exit} tone={color.text} size={24} />
      </View>

      <View style={[st.card, { borderColor: tint(tone, 0.6) }]} accessibilityLiveRegion="polite">
        {current ? (
          <>
            <View style={st.h}>
              {current.kind === "approval" ? <RiskBadge risk={current.approval.risk} /> : <PriorityChip priority={current.item.priority} solid />}
              <T v="micro" tone={tone}>{current.kind === "approval" ? "Approval" : SOURCE[current.item.source].label}</T>
            </View>
            <T v="display" style={st.title} numberOfLines={4}>{current.kind === "approval" ? current.approval.title : current.item.title}</T>
            <T v="body" dim numberOfLines={3} style={{ fontSize: 17, lineHeight: 24 }}>
              {current.kind === "approval" ? `${(current.approval.agentId && agents[current.approval.agentId]?.name) || "Agent"} · ${current.approval.summary ?? ""}` : [senderName(current.item.sender), current.item.snippet].filter(Boolean).join(" · ")}
            </T>
          </>
        ) : (
          <>
            <Icon name="check-circle" size={40} tone={color.ok} />
            <T v="display" style={st.title}>Queue clear</T>
            <T dim style={{ fontSize: 17 }}>Nothing needs you right now.</T>
          </>
        )}
        <View style={st.voiceLine}>
          <Icon name={d.listening ? "mic" : speaking ? "volume-2" : "volume-1"} size={16} tone={d.listening || speaking ? color.accent : color.textMuted} />
          <T v="small" numberOfLines={3} style={{ flex: 1 }} tone={d.listening ? color.accent : undefined}>
            {d.listening ? heard || "Listening… say next, repeat, approve, deny, snooze, reply, note or stop"
              : d.availability === "unavailable" ? "Speech recognition unavailable on this device. The buttons still work."
              : d.errorText ?? (heard ? `Heard: “${heard}”` : said)}
          </T>
        </View>
      </View>

      <View style={st.buttons}>
        <Big label="Repeat" icon="rotate-ccw" onPress={repeat} />
        <Big label="Next" icon="skip-forward" onPress={next} primary />
      </View>
      {d.availability === "hidden" ? null : (
        <View style={st.talk}>
          <MicButton listening={d.listening} level={d.level} onStart={talk} onStop={d.stop} size={112} disabled={d.availability === "unavailable"} label="Talk" />
          <T v="title" style={{ fontSize: 20 }} tone={d.availability === "unavailable" ? color.textMuted : color.text}>{d.listening ? "Listening" : "Talk"}</T>
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000000", padding: space.lg, gap: space.lg },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  h: { flexDirection: "row", alignItems: "center", gap: space.sm },
  card: { flex: 1, borderWidth: 2, borderRadius: radius.xl, backgroundColor: color.surface, padding: space.xl, gap: space.md, justifyContent: "center" },
  title: { fontSize: 32, lineHeight: 38 },
  voiceLine: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.border },
  buttons: { flexDirection: "row", gap: space.md },
  big: { flex: 1, minHeight: 116, borderRadius: radius.xl, borderWidth: 2, borderColor: color.borderStrong, backgroundColor: color.surface2, alignItems: "center", justifyContent: "center", gap: space.sm },
  talk: { alignItems: "center", gap: space.sm, paddingTop: space.sm },
});
