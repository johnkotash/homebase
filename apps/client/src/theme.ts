import { Platform, type TextStyle } from "react-native";
import type { Priority, Risk, Tone } from "@homebase/protocol";

/**
 * Monochrome, dark-first tokens. Pure neutral greys (no hue tint); the accent is white,
 * so primary actions read as white-on-black. Colour is reserved for urgency only:
 * red for P0/danger, amber for P1/warn. Everything else stays greyscale.
 */
export const color = {
  bg: "#000000",
  surface: "#0E0E0E",
  surface2: "#161616",
  surface3: "#1F1F1F",
  border: "#262626",
  borderStrong: "#3A3A3A",
  text: "#FAFAFA",
  textDim: "#A3A3A3",
  textMuted: "#6B6B6B",
  accent: "#FFFFFF",
  accentDim: "rgba(255,255,255,0.10)",
  accentInk: "#000000",
  p0: "#F0484E",
  p1: "#E0A33A",
  p2: "#C8C8C8",
  p3: "#737373",
  ok: "#E5E5E5",
  warn: "#E0A33A",
  danger: "#F0484E",
  overlay: "rgba(0,0,0,0.75)",
} as const;

/**
 * The four meanings an agent can give its own words (packages/protocol/src/agentMarkup.ts). These colour
 * agent content only: text inside a reply, a plan or a run timeline. Never chrome. Critical and warning
 * are the P0 and P1 tokens; success and info are two quiet hues that exist nowhere else in the app.
 */
export const toneColor: Record<Tone, string> = { critical: color.p0, warning: color.p1, success: "#7BC79A", info: "#8DB6EC" };
export const toneLabel: Record<Tone, string> = { critical: "Critical", warning: "Warning", success: "Success", info: "Note" };

export const priorityColor: Record<Priority, string> = { P0: color.p0, P1: color.p1, P2: color.p2, P3: color.p3 };
export const riskColor: Record<Risk, string> = { low: color.p2, medium: color.p1, high: color.p0 };
export const tint = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;
export const touch = 48;

export const font = {
  display: "SpaceGrotesk_700Bold",
  heading: "SpaceGrotesk_600SemiBold",
  label: "SpaceGrotesk_500Medium",
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }) as string,
};

export const type: Record<string, TextStyle> = {
  display: { fontFamily: font.display, fontSize: 30, lineHeight: 34, letterSpacing: -0.6, color: color.text },
  title: { fontFamily: font.heading, fontSize: 21, lineHeight: 26, letterSpacing: -0.3, color: color.text },
  heading: { fontFamily: font.heading, fontSize: 16, lineHeight: 21, letterSpacing: -0.1, color: color.text },
  body: { fontSize: 15, lineHeight: 22, color: color.text },
  small: { fontSize: 13, lineHeight: 18, color: color.textDim },
  micro: { fontFamily: font.label, fontSize: 11, lineHeight: 14, letterSpacing: 1.1, textTransform: "uppercase", color: color.textMuted },
  num: { fontFamily: font.display, fontSize: 26, lineHeight: 30, letterSpacing: -0.5, color: color.text, fontVariant: ["tabular-nums"] },
  mono: { fontFamily: font.mono, fontSize: 13, lineHeight: 19, color: color.text },
};

export const breakpoint = { rail: 900, split: 1100 } as const;
