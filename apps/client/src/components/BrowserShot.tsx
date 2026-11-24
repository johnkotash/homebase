import React, { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { hasBrowser } from "../browser";
import { useMap } from "../sync/hooks";
import { color, radius, space } from "../theme";
import { openBrowser } from "./BrowserPanel";
import { ArtifactImage } from "./ImageCards";
import { Btn, Card, Icon, SectionTitle, T } from "./ui";

/**
 * Two small pieces of the browser that other screens show: the picture of a step on a run's timeline,
 * and the Browser section of Settings. Kept apart from the live view so those screens do not load it.
 */

/** The picture the browser took after one of the agent's steps. Small on the timeline; tap for the whole page. */
export function BrowserStepShot({ id, label }: { id: string; label: string }) {
  const [zoom, setZoom] = useState(false);
  const card = { artifactId: id, previewId: null, mime: "image/jpeg", name: label, width: 480, height: 300 };
  return (
    <>
      <Pressable onPress={() => setZoom(true)} accessibilityRole="imagebutton" accessibilityLabel={`${label}. Tap to enlarge.`} style={st.thumb} testID="browser-step-shot">
        <ArtifactImage card={card} style={{ width: "100%", height: "100%" }} />
      </Pressable>
      <Modal visible={zoom} transparent animationType="fade" onRequestClose={() => setZoom(false)} statusBarTranslucent>
        <Pressable style={st.zoom} onPress={() => setZoom(false)} accessibilityLabel="Close the picture">
          <ArtifactImage card={card} style={{ width: "100%", height: "86%" }} contain />
          <T v="small" numberOfLines={2} style={{ textAlign: "center" }}>{label}</T>
        </Pressable>
      </Modal>
    </>
  );
}

/** Settings: one row per machine that runs a browser for agents. */
export function BrowserSettingsSection() {
  const agents = useMap("agents");
  const connectors = useMap("connectors");
  const nodes = useMemo(() => {
    const seen = new Map<string, { connectorId: string; name: string; online: boolean; agents: string[] }>();
    for (const a of Object.values(agents)) {
      if (!hasBrowser(a)) continue;
      const c = connectors[a.connectorId];
      const row = seen.get(a.connectorId) ?? { connectorId: a.connectorId, name: c?.name ?? "A connector", online: c?.status === "online", agents: [] };
      row.agents.push(a.name);
      seen.set(a.connectorId, row);
    }
    return [...seen.values()];
  }, [agents, connectors]);
  if (!nodes.length) return null;
  return (
    <>
      <SectionTitle title="Browser" count={nodes.length} />
      <Card pad={space.md} style={{ gap: space.sm }}>
        {nodes.map((n) => (
          <View key={n.connectorId} style={st.row}>
            <Icon name="globe" size={20} tone={n.online ? color.text : color.textMuted} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T numberOfLines={1}>Browser on {n.name}</T>
              <T v="small" muted numberOfLines={1}>{n.online ? `Used by ${n.agents.join(", ")}` : "That machine is offline"}</T>
            </View>
            <Btn small label="Open" icon="maximize-2" onPress={() => openBrowser(n.connectorId)} testID="settings-open-browser" />
          </View>
        ))}
        <T v="small" muted>Watch what an agent does on the web, take over, sign in to a site by hand, and set the rules agents browse under.</T>
      </Card>
    </>
  );
}

const st = StyleSheet.create({
  thumb: { width: 192, height: 120, borderRadius: radius.sm, borderWidth: 1, borderColor: color.border, overflow: "hidden", backgroundColor: color.surface, marginTop: 4 },
  zoom: { flex: 1, backgroundColor: color.overlay, alignItems: "center", justifyContent: "center", padding: space.lg, gap: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48 },
});
