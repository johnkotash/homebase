import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextProps, type TextStyle, type ViewStyle,
} from "react-native";
import { color, radius, space, tint, touch, type } from "../theme";

export type IconName = React.ComponentProps<typeof Feather>["name"];

type Variant = "display" | "title" | "heading" | "body" | "small" | "micro" | "num" | "mono";
export function T({ v = "body", dim, muted, tone, style, ...rest }: TextProps & { v?: Variant; dim?: boolean; muted?: boolean; tone?: string }) {
  return (
    <Text
      {...rest}
      style={[type[v], dim && { color: color.textDim }, muted && { color: color.textMuted }, tone ? { color: tone } : null, style]}
    />
  );
}

export function Icon({ name, size = 18, tone = color.textDim, style }: { name: IconName; size?: number; tone?: string; style?: StyleProp<TextStyle> }) {
  return <Feather name={name} size={size} color={tone} style={style} />;
}

export function Card({ children, style, onPress, tone, pad = space.lg }: {
  children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; tone?: string; pad?: number;
}) {
  const base = [s.card, { padding: pad }, tone ? { borderColor: tint(tone, 0.45), backgroundColor: tint(tone, 0.06) } : null, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed, hovered }: any) => [base, hovered && s.hover, pressed && s.pressed]}>
      {children}
    </Pressable>
  );
}

type BtnKind = "primary" | "secondary" | "ghost" | "danger" | "ok";
export function Btn({ label, onPress, kind = "secondary", icon, disabled, busy, small, style, testID, grow }: {
  label: string; onPress?: () => void; kind?: BtnKind; icon?: IconName; disabled?: boolean; busy?: boolean; small?: boolean;
  style?: StyleProp<ViewStyle>; testID?: string; grow?: boolean;
}) {
  const fg = kind === "primary" ? color.accentInk : kind === "danger" ? color.danger : kind === "ok" ? color.ok : color.text;
  const bg =
    kind === "primary" ? color.accent : kind === "danger" ? tint(color.danger, 0.13) : kind === "ok" ? tint(color.ok, 0.13)
    : kind === "ghost" ? "transparent" : color.surface3;
  const border = kind === "danger" ? tint(color.danger, 0.4) : kind === "ok" ? tint(color.ok, 0.4) : kind === "ghost" ? color.border : "transparent";
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed, hovered }: any) => [
        s.btn, small && s.btnSmall, { backgroundColor: bg, borderColor: border }, grow && { flex: 1 },
        hovered && { opacity: 0.92 }, pressed && { opacity: 0.75, transform: [{ scale: 0.985 }] }, (disabled || busy) && { opacity: 0.4 }, style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Feather name={icon} size={small ? 15 : 17} color={fg} /> : null}
      <Text numberOfLines={1} style={[s.btnLabel, small && { fontSize: 13 }, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function IconBtn({ icon, onPress, label, tone = color.textDim, size = 20, badge, style, active, testID }: {
  icon: IconName; onPress?: () => void; label: string; tone?: string; size?: number; badge?: number; style?: StyleProp<ViewStyle>; active?: boolean; testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed, hovered }: any) => [s.iconBtn, active && { backgroundColor: color.accentDim }, hovered && s.hover, pressed && s.pressed, style]}
    >
      <Feather name={icon} size={size} color={active ? color.accent : tone} />
      {badge ? (
        <View style={s.badge}><Text style={s.badgeText}>{badge > 9 ? "9+" : badge}</Text></View>
      ) : null}
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, tone, count, icon }: {
  label: string; selected?: boolean; onPress?: () => void; tone?: string; count?: number; icon?: IconName;
}) {
  const c = tone ?? color.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed, hovered }: any) => [
        s.chip, selected ? { backgroundColor: tint(c, 0.16), borderColor: tint(c, 0.6) } : null, hovered && !selected && s.hover, pressed && s.pressed,
      ]}
    >
      {icon ? <Feather name={icon} size={13} color={selected ? c : color.textDim} /> : null}
      <Text style={[s.chipLabel, { color: selected ? c : color.textDim }]}>{label}</Text>
      {count != null ? <Text style={[s.chipCount, { color: selected ? c : color.textMuted }]}>{count}</Text> : null}
    </Pressable>
  );
}

/** Small filled label: priority, risk, status. */
export function Tag({ label, tone = color.textDim, solid, icon }: { label: string; tone?: string; solid?: boolean; icon?: IconName }) {
  return (
    <View style={[s.tag, { backgroundColor: solid ? tone : tint(tone, 0.15) }]}>
      {icon ? <Feather name={icon} size={11} color={solid ? color.bg : tone} /> : null}
      <Text style={[s.tagText, { color: solid ? color.bg : tone }]}>{label}</Text>
    </View>
  );
}

export function Dot({ tone, size = 8, style }: { tone: string; size?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: size, height: size, borderRadius: size, backgroundColor: tone }, style]} />;
}

export function Row({ children, onPress, selected, style, ...rest }: PressableProps & { children: React.ReactNode; selected?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      {...rest}
      onPress={onPress}
      style={({ pressed, hovered }: any) => [s.row, selected && s.rowSelected, hovered && !selected && s.hover, pressed && s.pressed, style]}
    >
      {children}
    </Pressable>
  );
}

export function SectionTitle({ title, action, onAction, count, tone }: { title: string; action?: string; onAction?: () => void; count?: number; tone?: string }) {
  return (
    <View style={s.section}>
      <View style={s.h}>
        <T v="micro" tone={tone}>{title}</T>
        {count != null ? <T v="micro" tone={tone ?? color.textDim}>{`  ${count}`}</T> : null}
      </View>
      {action ? (
        <Pressable onPress={onAction} hitSlop={10} style={s.h}>
          <T v="small" tone={color.accent}>{action}</T>
          <Feather name="chevron-right" size={14} color={color.accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function Empty({ icon, title, body, children }: { icon: IconName; title: string; body?: string; children?: React.ReactNode }) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}><Feather name={icon} size={22} color={color.textMuted} /></View>
      <T v="heading" style={{ textAlign: "center" }}>{title}</T>
      {body ? <T v="small" style={{ textAlign: "center", maxWidth: 320 }}>{body}</T> : null}
      {children}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: color.border }, style]} />;
}

export function Segmented<V extends string>({ value, options, onChange }: { value: V; options: Array<{ value: V; label: string; icon?: IconName }>; onChange: (v: V) => void }) {
  return (
    <View style={s.segmented}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityState={{ selected: on }} style={[s.segment, on && s.segmentOn]}>
            {o.icon ? <Feather name={o.icon} size={14} color={on ? color.text : color.textMuted} /> : null}
            <Text style={[s.segmentLabel, { color: on ? color.text : color.textMuted }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} onPress={() => onChange(!value)} hitSlop={8}
      style={[s.toggle, value && { backgroundColor: color.accent, borderColor: color.accent }]}>
      <View style={[s.knob, value && { transform: [{ translateX: 20 }], backgroundColor: color.accentInk }]} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  h: { flexDirection: "row", alignItems: "center" },
  card: { backgroundColor: color.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border },
  hover: { backgroundColor: color.surface2 },
  pressed: { opacity: 0.8 },
  btn: {
    minHeight: touch, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1, flexDirection: "row", alignItems: "center",
    justifyContent: "center", gap: space.sm,
  },
  btnSmall: { minHeight: 38, paddingHorizontal: space.md, borderRadius: radius.sm + 2 },
  btnLabel: { fontFamily: "SpaceGrotesk_600SemiBold", fontSize: 15, letterSpacing: 0.1 },
  iconBtn: { width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  badge: {
    position: "absolute", top: 4, right: 2, minWidth: 17, height: 17, borderRadius: 9, backgroundColor: color.p0, alignItems: "center",
    justifyContent: "center", paddingHorizontal: 4, borderWidth: 2, borderColor: color.bg,
  },
  badgeText: { color: "#fff", fontSize: 9, fontWeight: "800" },
  chip: {
    height: 36, paddingHorizontal: 13, borderRadius: radius.pill, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface,
    flexDirection: "row", alignItems: "center", gap: 6,
  },
  chipLabel: { fontFamily: "SpaceGrotesk_500Medium", fontSize: 13 },
  chipCount: { fontSize: 12, fontVariant: ["tabular-nums"] },
  tag: { height: 22, paddingHorizontal: 8, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
  tagText: { fontFamily: "SpaceGrotesk_600SemiBold", fontSize: 11, letterSpacing: 0.4 },
  row: { paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 64, justifyContent: "center", borderRadius: radius.md },
  rowSelected: { backgroundColor: color.surface3 },
  section: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.xl, marginBottom: space.sm, paddingHorizontal: 2 },
  empty: { alignItems: "center", justifyContent: "center", padding: space.xxl, gap: space.sm, flexGrow: 1 },
  emptyIcon: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: color.surface2, alignItems: "center", justifyContent: "center", marginBottom: space.sm,
    borderWidth: 1, borderColor: color.border,
  },
  segmented: { flexDirection: "row", backgroundColor: color.surface2, borderRadius: radius.md, padding: 3, borderWidth: 1, borderColor: color.border },
  segment: { flex: 1, minHeight: 38, borderRadius: radius.sm + 1, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6, paddingHorizontal: space.md },
  segmentOn: { backgroundColor: color.surface3 },
  segmentLabel: { fontFamily: "SpaceGrotesk_500Medium", fontSize: 13 },
  toggle: { width: 48, height: 28, borderRadius: 14, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface3, padding: 3 },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.textDim },
});
