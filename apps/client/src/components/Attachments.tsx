import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { MAX_ATTACHMENTS, newId, type MessageAttachment } from "@homebase/protocol";
import { overflowText, pastedName, thumbGrid, type DraftPicture } from "../attachments";
import {
  chooseFilesWeb, clipboardPicture, isWeb, localPreviews, pickFromLibrary, prepareBlob, prepareNative, previewOf, takePhoto, uploadPicture,
  type NativePick, type Prepared,
} from "../attachUpload";
import { bytesText } from "../images";
import { showToast } from "../sync/session";
import { color, radius, space } from "../theme";
import { useHubSource } from "./ImageCards";
import { Sheet } from "./Sheet";
import { Btn, Icon, IconBtn, T } from "./ui";

/**
 * Pictures on a message, the same on the phone and the desktop: the strip of thumbnails above the message box
 * (each with an x), the paperclip that adds them, and the pictures inside a sent message (tap for full size).
 * On the desktop a screenshot pasted with Ctrl+V or an image dropped on the chat lands in the same strip.
 */

type Source = { kind: "blob"; blob: Blob; name: string | null } | { kind: "native"; pick: NativePick };

/** The pictures in the composer: add (each is scaled and uploaded at once), remove, clear after sending. */
export function useDraftPictures(enabled: boolean) {
  const [drafts, setDrafts] = useState<DraftPicture[]>([]);
  const live = useRef(true);
  const count = useRef(0);
  useEffect(() => () => void (live.current = false), []);
  const patch = (id: string, p: Partial<DraftPicture>) => live.current && setDrafts((all) => all.map((d) => (d.id === id ? { ...d, ...p } : d)));

  const add = useCallback((sources: Source[]) => {
    if (!enabled || !sources.length) return;
    const room = Math.max(0, MAX_ATTACHMENTS - count.current);
    const over = overflowText(sources.length, room);
    if (over) showToast("Not all images were attached", over, "error");
    const take = sources.slice(0, room);
    const fresh = take.map((s): DraftPicture => ({
      id: newId("att"), status: "preparing", preview: s.kind === "native" ? s.pick.uri : null,
      name: s.kind === "blob" ? s.name : s.pick.name, attachment: null, error: null,
    }));
    count.current += fresh.length;
    setDrafts((all) => [...all, ...fresh]);
    take.forEach((s, i) => {
      const d = fresh[i];
      void (async () => {
        let prepared: Prepared;
        try {
          prepared = s.kind === "blob" ? await prepareBlob(s.blob, s.name) : await prepareNative(s.pick);
        } catch (err) {
          return patch(d.id, { status: "error", error: (err as Error).message });
        }
        const preview = previewOf(prepared);
        patch(d.id, { status: "uploading", preview });
        try {
          const attachment = await uploadPicture(d.id, prepared, d.name);
          localPreviews.set(d.id, preview);
          patch(d.id, { status: "ready", attachment });
        } catch (err) {
          patch(d.id, { status: "error", error: (err as Error).message });
        }
      })();
    });
  }, [enabled]);

  const remove = useCallback((id: string) => {
    count.current = Math.max(0, count.current - 1);
    setDrafts((all) => all.filter((d) => d.id !== id));
  }, []);
  const clear = useCallback(() => {
    count.current = 0;
    setDrafts([]);
  }, []);

  /** Files from a paste, a drop or the file picker (browser and desktop). */
  const addFiles = useCallback((files: File[], pasted = false) => {
    add(files.map((f) => ({ kind: "blob", blob: f, name: f.name && !(pasted && /^image\.\w+$/i.test(f.name)) ? f.name : pastedName(f.type) })));
  }, [add]);
  const addPicks = useCallback((picks: NativePick[]) => add(picks.map((pick) => ({ kind: "native", pick }))), [add]);
  return { drafts, add, addFiles, addPicks, remove, clear };
}

/** The thumbnails above the message box. */
export function DraftStrip({ drafts, onRemove }: { drafts: DraftPicture[]; onRemove: (id: string) => void }) {
  if (!drafts.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.strip} keyboardShouldPersistTaps="handled" testID="attach-strip">
      {drafts.map((d) => (
        <View key={d.id} style={[st.chip, d.status === "error" && { borderColor: color.warn }]} accessibilityLabel={`${d.name ?? "Image"}${d.status === "error" ? `: ${d.error}` : d.status === "ready" ? "" : ", uploading"}`} testID="attach-chip">
          {d.preview && d.status !== "error" ? <Image source={{ uri: d.preview }} style={st.chipImg} resizeMode="cover" /> : (
            <View style={[st.chipImg, st.center]}><Icon name={d.status === "error" ? "alert-triangle" : "image"} size={18} tone={d.status === "error" ? color.warn : color.textMuted} /></View>
          )}
          {d.status === "preparing" || d.status === "uploading" ? (
            <View style={[StyleSheet.absoluteFill, st.center, st.busy]}><ActivityIndicator size="small" color={color.accent} /></View>
          ) : null}
          <Pressable onPress={() => onRemove(d.id)} accessibilityRole="button" accessibilityLabel={`Remove ${d.name ?? "image"}`} hitSlop={8} style={st.x} testID="attach-remove">
            <Icon name="x" size={12} tone={color.accentInk} />
          </Pressable>
          {d.status === "error" ? <T v="small" tone={color.warn} numberOfLines={3} style={st.chipErr}>{d.error}</T> : null}
          {d.status === "ready" && d.attachment ? <T v="small" muted style={st.chipSize}>{bytesText(d.attachment.bytes)}</T> : null}
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * The paperclip. On the desktop it opens the file picker (paste and drop work without it). On the phone it opens a
 * short sheet: photo library (several at once), camera, or the picture on the clipboard.
 */
export function AttachButton({ room, disabled, refusal, onFiles, onPicks }: {
  room: number; disabled?: boolean; refusal: string | null; onFiles: (f: File[]) => void; onPicks: (p: NativePick[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const blocked = () => {
    if (refusal) {
      showToast("Images can't be sent here", refusal, "error");
      return true;
    }
    if (room <= 0) {
      showToast("No room for more images", overflowText(1, 0) ?? undefined, "error");
      return true;
    }
    return false;
  };
  const press = () => {
    if (disabled || blocked()) return;
    if (isWeb) void chooseFilesWeb().then((f) => f.length && onFiles(f));
    else setOpen(true);
  };
  const run = (fn: () => Promise<NativePick[]>) => {
    setOpen(false);
    // Let the sheet close before Android's own picker opens over it.
    setTimeout(() => void fn().then((p) => p.length && onPicks(p), (err) => showToast("Could not attach", (err as Error).message, "error")), 250);
  };
  return (
    <>
      <IconBtn icon="paperclip" label={refusal ? "Attach images (not available for this agent)" : "Attach images"} onPress={press} tone={refusal ? color.textMuted : color.textDim}
        style={st.clip} testID="attach-button" />
      {isWeb ? null : (
        <Sheet visible={open} title="Attach images" subtitle={`Up to ${room} more on this message`} onClose={() => setOpen(false)} testID="attach-sheet">
          <View style={{ gap: space.sm }}>
            <Btn icon="image" label="Photo library" onPress={() => run(() => pickFromLibrary(room))} testID="attach-library" />
            <Btn icon="camera" label="Take a photo" onPress={() => run(takePhoto)} testID="attach-camera" />
            <Btn icon="clipboard" label="Paste image from clipboard" kind="ghost" testID="attach-paste"
              onPress={() => run(async () => {
                const p = await clipboardPicture();
                if (!p) throw new Error("There is no image on the clipboard. Copy a picture or a screenshot first.");
                return [p];
              })} />
          </View>
        </Sheet>
      )}
    </>
  );
}

/** One picture of a sent message, from this device's own copy when it has one, else from the hub. */
function HubPicture({ a, style, contain }: { a: MessageAttachment; style: any; contain?: boolean }) {
  const { source, failed, fail } = useHubSource(`/v1/attachments/${a.id}`, localPreviews.get(a.id) ?? null);
  if (failed) return <View style={[style, st.center, st.missing]}><Icon name="image" size={18} tone={color.textMuted} /><T v="small" muted style={{ fontSize: 11, textAlign: "center" }}>Could not load</T></View>;
  if (!source) return <View style={[style, st.missing]} />;
  return <Image source={source} style={style} resizeMode={contain ? "contain" : "cover"} onError={fail} accessibilityLabel={a.name ?? "Attached image"} testID="message-picture" />;
}

/** The pictures inside a sent message: a small grid; a tap opens them full size, one at a time. */
export function MessagePictures({ items }: { items: MessageAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const { width } = useWindowDimensions();
  if (!items.length) return null;
  const { columns, tile } = thumbGrid(items.length, Math.min(width * 0.7, 320));
  const single = items.length === 1 ? items[0] : null;
  const aspect = single?.width && single?.height ? Math.min(2.2, Math.max(0.45, single.width / single.height)) : 1;
  return (
    <View style={[st.grid, { width: single ? tile : columns * tile + (columns - 1) * 4 }]} testID="message-pictures">
      {items.map((a, i) => (
        <Pressable key={a.id} onPress={() => setOpen(i)} accessibilityRole="imagebutton" accessibilityLabel={`${a.name ?? `Image ${i + 1}`}. Tap to view full size.`}>
          <HubPicture a={a} style={single ? { width: tile, height: Math.round(tile / aspect), borderRadius: radius.sm } : { width: tile, height: tile, borderRadius: radius.sm }} />
        </Pressable>
      ))}
      <PictureViewer items={items} index={open} onIndex={setOpen} />
    </View>
  );
}

/** Full size, one picture at a time, with previous / next for several. Esc, the x or a tap on the dark area closes it. */
function PictureViewer({ items, index, onIndex }: { items: MessageAttachment[]; index: number | null; onIndex: (i: number | null) => void }) {
  const a = index == null ? null : items[index];
  useEffect(() => {
    if (index == null || Platform.OS !== "web") return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onIndex(null);
      else if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, items.length, onIndex]);
  return (
    <Modal visible={a != null} transparent animationType="fade" onRequestClose={() => onIndex(null)} statusBarTranslucent>
      <View style={st.viewer}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => onIndex(null)} accessibilityLabel="Close the picture" />
        {a ? <HubPicture a={a} style={{ width: "100%", height: "84%" }} contain /> : null}
        <View style={st.viewerBar} pointerEvents="box-none">
          {items.length > 1 ? <IconBtn icon="chevron-left" label="Previous image" onPress={() => index! > 0 && onIndex(index! - 1)} tone={index! > 0 ? color.text : color.textMuted} /> : null}
          <T v="small" numberOfLines={1} style={{ flexShrink: 1, textAlign: "center" }}>
            {a ? `${items.length > 1 ? `${index! + 1} of ${items.length} · ` : ""}${a.name ?? "Image"}${a.width && a.height ? ` · ${a.width} × ${a.height}` : ""} · ${bytesText(a.bytes)}` : ""}
          </T>
          {items.length > 1 ? <IconBtn icon="chevron-right" label="Next image" onPress={() => index! < items.length - 1 && onIndex(index! + 1)} tone={index! < items.length - 1 ? color.text : color.textMuted} /> : null}
          <IconBtn icon="x" label="Close" onPress={() => onIndex(null)} tone={color.text} />
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  strip: { gap: space.sm, paddingBottom: space.sm, paddingHorizontal: 2 },
  chip: { width: 72, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface2, overflow: "hidden" },
  chipImg: { width: 72, height: 72 },
  chipErr: { fontSize: 10, lineHeight: 12, padding: 4 },
  chipSize: { fontSize: 10, lineHeight: 12, paddingHorizontal: 4, paddingVertical: 2 },
  center: { alignItems: "center", justifyContent: "center" },
  busy: { backgroundColor: "rgba(0,0,0,0.45)" },
  x: { position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: color.accent, alignItems: "center", justifyContent: "center" },
  clip: { width: 44, height: 44, borderRadius: 22, marginBottom: 7 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  missing: { backgroundColor: color.surface2, borderRadius: radius.sm, gap: 4 },
  viewer: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", alignItems: "center", justifyContent: "center", padding: space.lg },
  viewerBar: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.md, maxWidth: "100%" },
});
