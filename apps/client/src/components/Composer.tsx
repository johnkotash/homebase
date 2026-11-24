import React, { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MAX_ATTACHMENTS, type MessageAttachment } from "@homebase/protocol";
import { draftsLine, pasteAction, sendState } from "../attachments";
import { imagesFromTransfer } from "../attachUpload";
import { useSetting } from "../sync/hooks";
import { showToast } from "../sync/session";
import { AttachButton, DraftStrip, useDraftPictures } from "./Attachments";
import { color, radius, space } from "../theme";
import { beginDraft, draftCancel, draftEdited, draftFinal, draftPartial } from "../voice/dictationDraft";
import { useDictation } from "../voice/useDictation";
import { dictationShortcutLabel, useDictationShortcut } from "../voice/useDictationShortcut";
import { MicButton } from "./MicButton";
import { Icon, IconBtn, T } from "./ui";

/**
 * Text composer with push-to-talk. While the mic is held the partial transcript appears live in the
 * field; on release the final text is inserted for review, or sent at once if "send on release" is on.
 *
 * With a keyboard (desktop window, browser) the same dictation also runs from Ctrl+D: press to start,
 * press again to stop and review, or hold it down while talking. Enter stops and sends, Esc cancels and
 * puts the field back. The rules are in voice/dictationShortcut.ts.
 */
export function Composer({ onSend, placeholder = "Message", hint, disabled, accessory, attach }: {
  onSend: (text: string, source: "text" | "voice", attachments?: MessageAttachment[]) => void; placeholder?: string; hint?: string; disabled?: boolean;
  /** A small control shown above the field, on the left (the chat's permission-mode switch). */
  accessory?: React.ReactNode;
  /**
   * Pictures on the message (paperclip, paste, drop). Left out: no pictures here. `refusal` set: the agent cannot
   * look at pictures, and trying says so instead of dropping them.
   */
  attach?: { refusal: string | null };
}) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [fromVoice, setFromVoice] = useState(false);
  const draft = useRef(beginDraft("")); // what is typed, and where dictated words are added (voice/dictationDraft.ts)
  const enterSends = useRef(false); // Enter was pressed while listening: send once the words have landed
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const sendOnRelease = useSetting("voice.sendOnRelease", false);
  const keyboard = Platform.OS === "web";
  const pics = useDraftPictures(!!attach && !attach.refusal);
  // Send was pressed while pictures were still uploading: it goes as soon as they are up.
  const [queued, setQueued] = useState<"text" | "voice" | null>(null);
  const [dragging, setDragging] = useState(false);

  const send = (value = text, source: "text" | "voice" = fromVoice ? "voice" : "text") => {
    const v = value.trim();
    const s = sendState(v, pics.drafts);
    if (!s.hasContent || disabled) return;
    if (s.failed) return void showToast("Remove the images that failed", "They could not be attached. Remove them (x) to send the rest.", "error");
    if (s.problem) return void showToast("Too many images", s.problem, "error");
    if (s.waiting) return void setQueued(source);
    setQueued(null);
    onSend(v, source, s.ready.length ? s.ready : undefined);
    setText("");
    draft.current = beginDraft("");
    setFromVoice(false);
    pics.clear();
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const waiting = sendState("", pics.drafts).waiting;
  const failedCount = sendState("", pics.drafts).failed;
  useEffect(() => {
    if (!queued || waiting) return;
    if (failedCount) return void setQueued(null); // the line under the box says why it did not go
    sendRef.current(undefined, queued);
  }, [queued, waiting, failedCount]);

  // Desktop and browser: Ctrl+V of a screenshot attaches it; text paste is untouched. Images dropped anywhere on the chat attach too.
  const attachRef = useRef(attach);
  attachRef.current = attach;
  const offerFiles = (files: File[], others: string[], pasted: boolean) => {
    if (others.length && !files.length) return void showToast("Only images can be attached", `${others.slice(0, 3).join(", ")} ${others.length === 1 ? "is not an image" : "are not images"}. Use PNG, JPEG, WebP or GIF.`, "error");
    if (!files.length) return;
    const a = attachRef.current;
    if (a?.refusal) return void showToast("Images can't be sent here", a.refusal, "error");
    if (others.length) showToast("Only the images were attached", `${others.slice(0, 3).join(", ")} ${others.length === 1 ? "is not an image" : "are not images"}.`, "error");
    pics.addFiles(files, pasted);
  };
  useEffect(() => {
    if (!keyboard || !attach) return;
    const node = input.current as unknown as HTMLElement | null;
    const onPaste = (e: ClipboardEvent) => {
      const { files, others } = imagesFromTransfer(e.clipboardData);
      if (pasteAction({ text: e.clipboardData?.getData("text/plain"), images: files.length }) !== "attach") return;
      e.preventDefault();
      offerFiles(files, others, true);
    };
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // without this the window would open the file instead of dropping it here
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const { files, others } = imagesFromTransfer(e.dataTransfer);
      offerFiles(files, others, false);
    };
    node?.addEventListener?.("paste", onPaste as EventListener);
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      node?.removeEventListener?.("paste", onPaste as EventListener);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboard, !!attach, pics.addFiles]);
  const picsLine = draftsLine(pics.drafts, !!queued);
  const canSend = !!text.trim() || pics.drafts.length > 0;

  const d = useDictation({
    onPartial: (p) => setText(draftPartial(draft.current, p)),
    onFinal: (f) => {
      const next = draftFinal(draft.current, f);
      draft.current = next.draft;
      setText(next.text);
      setFromVoice(true);
      if (keyboard) input.current?.focus(); // ready for Enter, or for fixing a word
      if (sendOnRelease) send(next.text, "voice");
    },
    // Esc: the field goes back to what it held before this dictation.
    onCancel: () => {
      enterSends.current = false;
      const back = draftCancel(draft.current);
      draft.current = beginDraft(back);
      setText(back);
    },
  });
  const startDictation = () => {
    draft.current = beginDraft(draft.current.base); // remembered for Esc
    enterSends.current = false;
    void d.start();
  };
  const stopDictation = () => void d.stop();
  useDictationShortcut({
    available: d.availability === "available" && !disabled, listening: d.listening, finishing: d.finishing, stop: stopDictation, cancel: d.cancel,
    start: () => {
      startDictation();
      input.current?.focus(); // so Enter and typing go to this box (not from the mic button: moving focus mid-press would end the press)
    },
  });

  return (
    <View style={[st.wrap, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
      {d.finishing ? (
        <View style={st.status}><View style={st.rec} /><T v="small" tone={color.accent}>{d.notice ?? "Transcribing…"}</T>{keyboard ? <T v="small" muted>Esc to cancel</T> : null}</View>
      ) : d.listening ? (
        <View style={st.status}>
          <View style={st.rec} />
          <T v="small" tone={color.accent}>{d.notice ? `Listening… ${d.notice}` : keyboard ? `Listening… ${dictationShortcutLabel} to ${sendOnRelease ? "send" : "stop and review"}` : `Listening… release to ${sendOnRelease ? "send" : "review"}`}</T>
          {keyboard && !d.notice ? <T v="small" muted>Enter to send · Esc to cancel</T> : null}
        </View>
      ) : d.availability === "unavailable" ? (
        <View style={st.status}><Icon name="mic-off" size={13} tone={color.textMuted} /><T v="small" muted>Speech recognition unavailable on this device. Typing still works.</T></View>
      ) : d.errorText ? (
        <View style={st.status}><Icon name="alert-circle" size={13} tone={color.warn} /><T v="small" tone={color.warn}>{d.errorText}</T></View>
      ) : hint && !accessory ? (
        <View style={st.status}><T v="small" muted>{hint}</T></View>
      ) : null}
      {accessory ? (
        <View style={st.accessory}>
          {accessory}
          {hint && !d.listening && !d.errorText ? <T v="small" muted numberOfLines={2} style={{ flex: 1 }}>{hint}</T> : null}
        </View>
      ) : null}
      {attach ? <DraftStrip drafts={pics.drafts} onRemove={pics.remove} /> : null}
      {dragging && attach ? (
        <View style={st.status}><Icon name="image" size={13} tone={attach.refusal ? color.warn : color.accent} /><T v="small" tone={attach.refusal ? color.warn : color.accent}>{attach.refusal ?? "Drop the images to attach them"}</T></View>
      ) : picsLine ? (
        <View style={st.status} testID="attach-line"><Icon name={picsLine.warn ? "alert-circle" : "upload"} size={13} tone={picsLine.warn ? color.warn : color.textMuted} /><T v="small" tone={picsLine.warn ? color.warn : undefined} muted={!picsLine.warn} style={{ flexShrink: 1 }}>{picsLine.text}</T></View>
      ) : null}
      <View style={st.row}>
        <View style={[st.field, attach && st.fieldClip, (d.listening || (dragging && !attach?.refusal)) && { borderColor: color.accent }]}>
          {attach ? <AttachButton room={MAX_ATTACHMENTS - pics.drafts.length} disabled={disabled} refusal={attach.refusal} onFiles={(f) => pics.addFiles(f)} onPicks={pics.addPicks} /> : null}
          <TextInput
            ref={input}
            value={text}
            onChangeText={(v) => {
              setText(v);
              draft.current = draftEdited(draft.current, v);
              if (!v) setFromVoice(false);
            }}
            placeholder={d.listening ? "Listening…" : keyboard && d.availability === "available" ? `${placeholder}  (${dictationShortcutLabel} to dictate)` : placeholder}
            placeholderTextColor={color.textMuted}
            multiline
            editable={!disabled}
            accessibilityLabel={placeholder}
            style={st.input}
            onKeyPress={(e: any) => {
              // Desktop: Enter sends, Shift+Enter makes a new line.
              if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
                e.preventDefault();
                if (d.listening || d.finishing) {
                  // Stop and send in one step: wait for the last words, then send what is in the box.
                  enterSends.current = true;
                  void d.stop().then(() => {
                    if (!enterSends.current) return;
                    enterSends.current = false;
                    send(draft.current.base, "voice");
                  });
                } else send();
              }
            }}
          />
          <IconBtn icon="arrow-up" label={queued ? "Sending when the images are uploaded" : "Send"} onPress={() => send()} tone={canSend ? color.accentInk : color.textMuted}
            style={[st.send, canSend ? { backgroundColor: color.accent } : null, queued ? { opacity: 0.6 } : null]} testID="composer-send" />
        </View>
        {d.availability !== "hidden" ? (
          <MicButton listening={d.listening} level={d.level} onStart={startDictation} onStop={stopDictation} size={60} disabled={d.availability === "unavailable" || disabled} />
        ) : null}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { paddingHorizontal: space.md, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: color.border, backgroundColor: color.surface },
  status: { flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: space.sm, paddingHorizontal: 4 },
  accessory: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: space.sm, paddingHorizontal: 2 },
  rec: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.accent },
  row: { flexDirection: "row", alignItems: "flex-end", gap: space.md },
  field: {
    flex: 1, flexDirection: "row", alignItems: "flex-end", backgroundColor: color.bg, borderRadius: radius.xl, borderWidth: 1, borderColor: color.borderStrong,
    paddingLeft: space.lg, paddingRight: 6, minHeight: 60,
  },
  fieldClip: { paddingLeft: 6, gap: 2 },
  input: { flex: 1, color: color.text, fontSize: 16, lineHeight: 22, maxHeight: 140, paddingVertical: 18, outlineStyle: "none" } as any,
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.surface3, marginBottom: 7 },
});
