import {ActivityIndicator, Pressable, StyleSheet, Text, View} from "react-native";
import type {ReactNode} from "react";
import {formatUsdc, formatUsdcApprox, explainToOwner, describe, type Activity} from "@tollgate/shared";
import {mono, shortAddress, useTheme, type Theme} from "./theme.ts";

/**
 * The pieces every screen is built from.
 *
 * Two rules run through all of them, both from ADR 0007:
 *
 *   - Red means blocked or stopped. Nothing else.
 *   - Data that might be stale says how stale it is, in the same place, every time.
 */

export function Card({children, tone}: {children: ReactNode; tone?: "stop" | "ok"}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.card,
        {backgroundColor: t.surface, borderColor: tone === "stop" ? t.stop : t.line},
      ]}
    >
      {children}
    </View>
  );
}

export function Title({children}: {children: ReactNode}) {
  const t = useTheme();
  return <Text style={[styles.title, {color: t.text}]}>{children}</Text>;
}

export function Note({children}: {children: ReactNode}) {
  const t = useTheme();
  return <Text style={[styles.note, {color: t.muted}]}>{children}</Text>;
}

/**
 * How old is what you are looking at?
 *
 * Present on every screen showing policy or history, because the alternative is an app that
 * implies "now" when it means "some time ago". On a control plane for money that is not a
 * cosmetic difference.
 */
export function Freshness({
  label,
  stale,
  detail,
}: {
  label: string;
  stale: boolean;
  detail?: string;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.freshness,
        {
          backgroundColor: stale ? t.accentSoft : "transparent",
          borderColor: stale ? t.accent : t.line,
        },
      ]}
    >
      <View style={[styles.dot, {backgroundColor: stale ? t.accent : t.ok}]} />
      <Text style={[styles.freshnessText, {color: stale ? t.text : t.muted}]}>
        {label}
        {detail ? ` · ${detail}` : ""}
      </Text>
    </View>
  );
}

/**
 * The state this app must never get wrong.
 *
 * A phone that cannot reach the chain knows nothing, and has to say so rather than show the
 * last thing it saw. It also says the thing an owner in trouble most needs to hear: the kill
 * switch does not depend on this app.
 */
export function Offline({onRetry}: {onRetry: () => void}) {
  const t = useTheme();
  return (
    <Card tone="stop">
      <Title>Cannot reach Tollgate</Title>
      <Note>
        This phone cannot read your policy right now, so it cannot tell you what your agent is
        allowed to spend. Nothing shown elsewhere should be trusted until this clears — and no
        policy has changed, because reading is all the app was doing.
      </Note>
      <Text style={[styles.body, {color: t.text}]}>
        Your controls do not depend on this app. The policy lives on chain and can be paused
        from any wallet or block explorer.
      </Text>
      <Button label="Try again" onPress={onRetry} />
    </Card>
  );
}

export function Button({
  label,
  onPress,
  tone = "default",
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
  busy?: boolean;
}) {
  const t = useTheme();
  const background =
    tone === "danger" ? t.stop : tone === "primary" ? t.accent : t.surface2;
  const color = tone === "default" ? t.text : "#ffffff";

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({pressed}) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: tone === "default" ? t.line : background,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, {color}]}>{label}</Text>}
    </Pressable>
  );
}

/** A budget or rate-limit bar. Gauges round down, so they never promise room that is not there. */
export function Meter({
  label,
  value,
  total,
  sense,
  caption,
}: {
  label: string;
  value: bigint;
  total: bigint;
  sense: "used" | "remaining";
  caption: string;
}) {
  const t = useTheme();
  const fraction = total === 0n ? 1 : Number((value * 1000n) / total) / 1000;
  const percent = Math.max(0, Math.min(1, fraction)) * 100;
  const high = sense === "used" ? fraction > 0.85 : fraction < 0.15;

  return (
    <View style={styles.meter}>
      <View style={styles.meterTop}>
        <Text style={[styles.meterLabel, {color: t.muted}]}>{label}</Text>
        <Text style={[styles.meterValue, mono, {color: t.text}]}>
          {formatUsdcApprox(value)} / {formatUsdcApprox(total)}
        </Text>
      </View>
      <View style={[styles.track, {backgroundColor: t.surface2}]}>
        <View
          style={[
            styles.fill,
            {width: `${percent}%`, backgroundColor: high ? t.stop : t.accent},
          ]}
        />
      </View>
      <Text style={[styles.caption, {color: t.muted}]}>{caption}</Text>
    </View>
  );
}

/** One row of the audit log. Red only when something was stopped. */
export function ActivityRow({entry, onPress}: {entry: Activity; onPress?: () => void}) {
  const t = useTheme();
  const blocked = entry.kind === "refused";

  return (
    <Pressable onPress={onPress} style={[styles.row, {borderColor: t.line}]}>
      <View style={styles.rowTop}>
        <Text style={[styles.rowWhat, {color: blocked ? t.stop : t.text}]}>{describe(entry)}</Text>
        {entry.amount !== undefined ? (
          <Text style={[styles.rowAmount, mono, {color: blocked ? t.stop : t.text}]}>
            {formatUsdc(entry.amount)}
          </Text>
        ) : null}
      </View>

      {entry.reason !== undefined ? (
        <Text style={[styles.rowWhy, {color: t.stop}]}>{explainToOwner(entry.reason)}</Text>
      ) : null}

      {entry.detail ? (
        <Text style={[styles.rowWhy, mono, {color: t.muted}]}>
          {entry.detail.label}: {entry.detail.values.map((v) => formatUsdc(v)).join(" · ")}
        </Text>
      ) : null}

      <View style={styles.rowSub}>
        {entry.payee ? (
          <Text style={[styles.rowMeta, mono, {color: t.muted}]}>{shortAddress(entry.payee)}</Text>
        ) : null}
        {entry.timestamp > 0 ? (
          <Text style={[styles.rowMeta, {color: t.muted}]}>{timeAgo(entry.timestamp)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function timeAgo(unixSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function makeStyles(t: Theme) {
  return t;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 14,
  },
  title: {fontSize: 16, fontWeight: "600", marginBottom: 6},
  note: {fontSize: 13, lineHeight: 19, marginBottom: 10},
  body: {fontSize: 13.5, lineHeight: 20, marginBottom: 12},
  freshness: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 9,
    borderWidth: 1,
    marginBottom: 14,
  },
  dot: {width: 7, height: 7, borderRadius: 4},
  freshnessText: {fontSize: 12},
  button: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 13,
    paddingHorizontal: 18,
    alignItems: "center",
    marginTop: 4,
  },
  buttonText: {fontSize: 14.5, fontWeight: "600"},
  meter: {marginBottom: 14},
  meterTop: {flexDirection: "row", justifyContent: "space-between", marginBottom: 6},
  meterLabel: {fontSize: 12},
  meterValue: {fontSize: 12.5},
  track: {height: 7, borderRadius: 4, overflow: "hidden"},
  fill: {height: "100%", borderRadius: 4},
  caption: {fontSize: 11.5, marginTop: 5},
  row: {borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 12},
  rowTop: {flexDirection: "row", justifyContent: "space-between", alignItems: "baseline"},
  rowWhat: {fontSize: 14, fontWeight: "500", flex: 1},
  rowAmount: {fontSize: 14, fontWeight: "600"},
  rowWhy: {fontSize: 12.5, marginTop: 3},
  rowSub: {flexDirection: "row", gap: 10, marginTop: 5},
  rowMeta: {fontSize: 11.5},
});
