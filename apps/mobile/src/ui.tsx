import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ColorValue, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { COLORS, FONTS, LOGO_PATH } from "./constants";

export function Logo({ size = 28, color = COLORS.forest }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel="Sikrets">
      <Path d={LOGO_PATH} fill={color} fillRule="evenodd" />
    </Svg>
  );
}

type IconName = "approvals" | "keys" | "chat" | "pair";

/** Tab icons, drawn on the logo's 24×24 grid. */
export function Icon({ name, color, size = 24 }: { name: IconName; color: ColorValue; size?: number }) {
  const c = String(color);
  const stroke = { stroke: c, strokeWidth: 1.8, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "approvals" && <Path d={LOGO_PATH} fill={c} fillRule="evenodd" />}
      {name === "keys" && (
        <>
          <Circle cx={8} cy={12} r={4} {...stroke} />
          <Path d="M12 12h9M18 12v3M21 12v2" {...stroke} />
        </>
      )}
      {name === "chat" && <Path d="M4 5h16v11H9l-5 4z" {...stroke} />}
      {name === "pair" && (
        <>
          <Rect x={3} y={3} width={7} height={7} rx={1} {...stroke} />
          <Rect x={14} y={3} width={7} height={7} rx={1} {...stroke} />
          <Rect x={3} y={14} width={7} height={7} rx={1} {...stroke} />
          <Path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" {...stroke} />
        </>
      )}
    </Svg>
  );
}

export function T({ children, style, variant = "body", numberOfLines }: { children: ReactNode; style?: StyleProp<TextStyle>; variant?: keyof typeof text; numberOfLines?: number }) {
  return (
    <Text style={[text[variant], style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  kind = "primary",
  busy,
  disabled,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  const bg = kind === "primary" ? COLORS.forest : kind === "danger" ? COLORS.cream : COLORS.cream;
  const fg = kind === "primary" ? COLORS.white : kind === "danger" ? COLORS.danger : COLORS.forest;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.85 : 1 }]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[text.button, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

const TONES = {
  pending: { bg: "#f6ecd9", fg: "#7a5414" },
  good: { bg: "#e3ece6", fg: COLORS.pine },
  bad: { bg: "#f3e2df", fg: COLORS.danger },
  quiet: { bg: COLORS.cream, fg: "#6d6862" },
} as const;

export function Badge({ label, tone = "quiet" }: { label: string; tone?: keyof typeof TONES }) {
  return (
    <View style={[styles.badge, { backgroundColor: TONES[tone].bg }]}>
      <Text style={[text.badge, { color: TONES[tone].fg }]}>{label}</Text>
    </View>
  );
}

export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.empty}>
      <Logo size={40} color={COLORS.muted} />
      <T variant="h3" style={{ marginTop: 16 }}>
        {title}
      </T>
      {detail ? <T style={{ color: "#6d6862", textAlign: "center", marginTop: 6 }}>{detail}</T> : null}
    </View>
  );
}

export const text = StyleSheet.create({
  h1: { fontFamily: FONTS.semibold, fontSize: 28, color: COLORS.forest, letterSpacing: -0.6 },
  h2: { fontFamily: FONTS.semibold, fontSize: 20, color: COLORS.ink, letterSpacing: -0.3 },
  h3: { fontFamily: FONTS.medium, fontSize: 16, color: COLORS.ink },
  body: { fontFamily: FONTS.regular, fontSize: 15, color: COLORS.ink, lineHeight: 21 },
  small: { fontFamily: FONTS.regular, fontSize: 13, color: "#6d6862" },
  mono: { fontFamily: FONTS.mono, fontSize: 13, color: COLORS.ink },
  button: { fontFamily: FONTS.medium, fontSize: 16 },
  badge: { fontFamily: FONTS.medium, fontSize: 12 },
});

const styles = StyleSheet.create({
  card: { backgroundColor: COLORS.white, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: COLORS.line, padding: 16 },
  button: { height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
});
