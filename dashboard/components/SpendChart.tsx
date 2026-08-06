"use client";

import {useState} from "react";
import {formatUsdc} from "@tollgate/shared";

export interface SpendPoint {
  timestamp: number;
  /** Cumulative lifetime spend after this payment, straight from the contract event. */
  total: bigint;
  amount: bigint;
  txHash: string;
}

/**
 * Cumulative spend against the ceiling.
 *
 * Step-after, not a smooth line, and that is the whole point: spending is discrete. A
 * curve between two payments would draw money leaving the wallet at moments when none
 * did, which on a page whose claim is "this is what actually happened" is not a
 * stylistic choice but a false statement.
 *
 * One series, so no legend — the title names it. The ceiling is a dashed rule because it
 * is a threshold rather than a gridline; the solid hairlines behind it are the grid, and
 * keeping the two visually distinct is what lets the dash mean "limit".
 *
 * The chart is never the record. Every point here is also a row in Activity with a link
 * to ArcScan, which is the accessible table view and the thing to trust if they disagree.
 */
export function SpendChart({
  points,
  budgetCap,
  height = 200,
}: {
  points: SpendPoint[];
  budgetCap: bigint;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return <div className="empty">No payments yet — the chart appears with the first one.</div>;
  }

  // Geometry in viewBox units. The box includes the x-axis band, so the card never grows
  // a nested scrollbar to reveal its own labels.
  // Scaled uniformly, never stretched: a non-uniform fit turns the point markers into
  // ellipses and quietly lies about the slope of every step.
  const W = 720;
  const H = height;
  const pct = (v: number) => `${(v / H) * 100}%`;
  const padL = 8;
  const padR = 58; // room for the endpoint label
  const padT = 18;
  const padB = 26; // the x-axis band

  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const cap = Number(budgetCap);
  const first = points[0]!;
  const last = points[points.length - 1]!;

  // Extend the x domain to now, so a flat tail honestly shows "nothing since".
  const t0 = first.timestamp;
  const t1 = Math.max(last.timestamp, Math.floor(Date.now() / 1000));
  const span = Math.max(t1 - t0, 1);

  const x = (t: number) => padL + ((t - t0) / span) * plotW;
  const y = (v: number) => padT + plotH - (Math.min(v, cap) / cap) * plotH;

  // Step-after: hold the previous total until the instant the next payment lands.
  let d = `M ${x(t0)} ${y(0)}`;
  let prev = 0;
  for (const p of points) {
    d += ` L ${x(p.timestamp)} ${y(prev)} L ${x(p.timestamp)} ${y(Number(p.total))}`;
    prev = Number(p.total);
  }
  d += ` L ${x(t1)} ${y(prev)}`;

  const area = `${d} L ${x(t1)} ${y(0)} L ${x(t0)} ${y(0)} Z`;

  const gridAt = [0.25, 0.5, 0.75];
  const active = hover === null ? null : points[hover];

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label={`Cumulative spend over time: ${formatUsdc(last.total)} of ${formatUsdc(budgetCap)} used across ${points.length} payments. The full figures are in the Activity table.`}
      >
        {gridAt.map((g) => (
          <line key={g} x1={padL} x2={padL + plotW} y1={y(cap * g)} y2={y(cap * g)} className="chart-grid" />
        ))}
        <line x1={padL} x2={padL + plotW} y1={y(0)} y2={y(0)} className="chart-axis" />

        {/* The ceiling. Dashed because it is a limit, not a gridline. */}
        <line x1={padL} x2={padL + plotW} y1={y(cap)} y2={y(cap)} className="chart-cap" />

        <path d={area} className="chart-area" />
        <path d={d} className="chart-line" />

        {active ? (
          <line
            x1={x(active.timestamp)}
            x2={x(active.timestamp)}
            y1={padT}
            y2={padT + plotH}
            className="chart-crosshair"
          />
        ) : null}

        {points.map((p, i) => (
          <circle
            key={p.txHash + i}
            cx={x(p.timestamp)}
            cy={y(Number(p.total))}
            r={hover === i ? 5 : 3.5}
            className="chart-dot"
          />
        ))}

        {/* Hit targets, generous and invisible — the marks are far too small to aim at. */}
        {points.map((p, i) => {
          const left = i === 0 ? padL : (x(points[i - 1]!.timestamp) + x(p.timestamp)) / 2;
          const right = i === points.length - 1 ? padL + plotW : (x(p.timestamp) + x(points[i + 1]!.timestamp)) / 2;
          return (
            <rect
              key={`hit-${p.txHash}-${i}`}
              x={left}
              y={padT}
              width={Math.max(right - left, 1)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>

      {/* Direct labels live outside the SVG so they keep the page's type scale instead of
          being scaled with the drawing. Positioned as a percentage of the plot box, which
          tracks the SVG whatever width it is given. Only two: the ceiling and the current
          total. A number on every point would go unread. */}
      <div className="chart-cap-label" style={{top: pct(y(cap))}}>
        {formatUsdc(budgetCap)} ceiling
      </div>
      <div className="chart-end-label" style={{top: pct(y(prev))}}>
        {formatUsdc(last.total)}
      </div>

      {active ? (
        <div className="chart-tip" style={{left: `${(x(active.timestamp) / W) * 100}%`}}>
          <strong>{formatUsdc(active.total)}</strong>
          <span>
            +{formatUsdc(active.amount)} · {new Date(active.timestamp * 1000).toLocaleString()}
          </span>
        </div>
      ) : null}

      <div className="chart-x">
        <span>{new Date(t0 * 1000).toLocaleDateString()}</span>
        <span>now</span>
      </div>
    </div>
  );
}
