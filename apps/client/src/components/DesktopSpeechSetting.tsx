import React, { useState } from "react";
import { View } from "react-native";
import { space } from "../theme";
import { desktopStt, getSttProfile, setSttProfile, type SttProfile } from "../voice/desktop/bridge";
import { Divider, Segmented, T } from "./ui";

/**
 * Settings, Voice, desktop app only: which Whisper model dictation uses on this PC. Kept on this PC,
 * not synced: another computer may be faster or slower. Renders nothing on the phone or in a browser.
 */
export function DesktopSpeechSetting() {
  const [profile, setProfile] = useState<SttProfile>(() => getSttProfile() ?? "fast");
  if (!desktopStt()) return null;
  return (
    <>
      <Divider />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48, flexWrap: "wrap" }}>
        <View style={{ flex: 1, minWidth: 220 }}>
          <T>Speech model</T>
          <T v="small">
            {profile === "fast"
              ? "Fast: Whisper base. Text follows your voice closely. Good for a quiet room and a decent microphone."
              : "Accurate: Whisper small. Fewer wrong words, and the text trails your voice by a few seconds. The first use downloads about 330 MB."}
          </T>
        </View>
        <View style={{ width: 200 }}>
          <Segmented value={profile} options={[{ value: "fast", label: "Fast" }, { value: "accurate", label: "Accurate" }]}
            onChange={(v) => { setSttProfile(v); setProfile(v); }} />
        </View>
      </View>
    </>
  );
}
