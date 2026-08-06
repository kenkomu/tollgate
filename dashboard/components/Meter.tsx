import {formatUsdc, formatUsdcApprox} from "@tollgate/shared";

interface MeterProps {
  label: string;
  value: bigint;
  total: bigint;
  /** "used" fills as it grows (budget); "remaining" fills as it grows (headroom). */
  sense: "used" | "remaining";
  caption?: string;
}

/**
 * A bar with a number on it.
 *
 * The two meters read in opposite directions on purpose. Budget shows what is *gone* —
 * a filling bar is bad news. Headroom shows what is *left* — a filling bar is good news.
 * Colour carries that: budget goes amber then red as it fills, headroom is green when
 * healthy and drains toward empty.
 */
export function Meter({label, value, total, sense, caption}: MeterProps) {
  const pct = total === 0n ? 0 : Math.min(100, Number((value * 10000n) / total) / 100);

  let tone = "";
  if (sense === "used") {
    if (pct >= 90) tone = "stopped";
  } else {
    tone = pct > 25 ? "ok" : pct > 0 ? "" : "stopped";
  }

  return (
    <div className="meter">
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          {/* A gauge, not a record — the bucket's sub-cent digits are noise on a bar. */}
          {formatUsdcApprox(value)}{" "}
          <span style={{color: "var(--muted)"}}>/ {formatUsdc(total)}</span>
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{width: `${pct}%`}} />
      </div>
      {caption ? (
        <div style={{color: "var(--muted)", fontSize: 12, marginTop: 6}}>{caption}</div>
      ) : null}
    </div>
  );
}
