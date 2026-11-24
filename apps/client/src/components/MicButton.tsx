import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { color, tint } from "../theme";

const TAP_MS = 300;

/**
 * Push-to-talk: hold to talk, release to stop. A quick tap latches recording until the next tap
 * (or until the recognizer hears silence). A press while it is already listening, however that
 * started (a latched tap, or the Ctrl+D shortcut on the desktop), stops it.
 */
export function MicButton({ listening, level = 0, onStart, onStop, size = 56, disabled, label = "Hold to talk" }: {
  listening: boolean; level?: number; onStart: () => void; onStop: () => void; size?: number; disabled?: boolean; label?: string;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const vol = useRef(new Animated.Value(0)).current;
  const downAt = useRef(0);
  const latched = useRef(false);
  const stopsOnRelease = useRef(false);

  useEffect(() => {
    if (!listening) {
      latched.current = false;
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1300, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  useEffect(() => {
    Animated.timing(vol, { toValue: listening ? level : 0, duration: 110, useNativeDriver: true }).start();
  }, [level, listening, vol]);

  const pressIn = () => {
    if (disabled) return;
    downAt.current = Date.now();
    stopsOnRelease.current = listening;
    if (listening) return; // already listening (latched, or started from the keyboard): handled on release
    onStart();
  };
  const pressOut = () => {
    if (disabled) return;
    const held = Date.now() - downAt.current;
    if (stopsOnRelease.current) {
      stopsOnRelease.current = false;
      latched.current = false;
      onStop();
    } else if (held < TAP_MS) {
      latched.current = true; // tap: keep listening
    } else {
      onStop();
    }
  };

  const ring = size * 0.5;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        pointerEvents="none"
        style={[s.ring, {
          width: size, height: size, borderRadius: ring, borderColor: color.accent,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [listening ? 0.55 : 0, 0] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.75] }) }],
        }]}
      />
      <Animated.View
        pointerEvents="none"
        style={[s.ring, {
          width: size, height: size, borderRadius: ring, backgroundColor: tint(color.accent, 0.22), borderWidth: 0,
          opacity: listening ? 1 : 0, transform: [{ scale: vol.interpolate({ inputRange: [0, 1], outputRange: [1.05, 1.5] }) }],
        }]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? "Stop listening" : label}
        accessibilityState={{ disabled, busy: listening }}
        onPressIn={pressIn}
        onPressOut={pressOut}
        delayLongPress={100000}
        style={({ pressed }) => [
          s.btn, { width: size, height: size, borderRadius: ring },
          listening ? s.on : null, disabled ? s.disabled : null, pressed && !disabled ? { transform: [{ scale: 0.95 }] } : null,
        ]}
      >
        <Feather name={disabled ? "mic-off" : "mic"} size={Math.round(size * 0.42)} color={disabled ? color.textMuted : color.accentInk} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  ring: { position: "absolute", borderWidth: 2 },
  btn: {
    backgroundColor: color.accent, alignItems: "center", justifyContent: "center",
    shadowColor: color.accent, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 0 }, elevation: 8,
  },
  on: { backgroundColor: "#D4D4D4" },
  disabled: { backgroundColor: color.surface3, shadowOpacity: 0, elevation: 0, borderWidth: 1, borderColor: color.border },
});
