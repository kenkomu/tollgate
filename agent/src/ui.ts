import {formatUsdc, reasonName} from "@tollgate/shared";
import type {AgentEvent} from "./tools.ts";

/**
 * Terminal rendering.
 *
 * The design language from §5.4 carries over to the terminal: one accent, red reserved
 * strictly for blocked and kill, and numbers that line up. Refusals are the interesting
 * events here, so they get the strongest treatment on screen.
 */

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string, s: string) => (useColour ? `[${code}m${s}[0m` : s);

export const dim = (s: string) => c("2", s);
export const bold = (s: string) => c("1", s);
export const amber = (s: string) => c("38;5;179", s);
export const green = (s: string) => c("38;5;71", s);
export const red = (s: string) => c("38;5;167", s);
export const grey = (s: string) => c("38;5;245", s);

export function banner(title: string, subtitle: string): void {
  const line = "─".repeat(Math.max(title.length, subtitle.length) + 4);
  console.log("");
  console.log(amber(line));
  console.log(`  ${bold(title)}`);
  console.log(`  ${grey(subtitle)}`);
  console.log(amber(line));
  console.log("");
}

export function field(label: string, value: string): void {
  console.log(`  ${grey(label.padEnd(18))} ${value}`);
}

export function renderEvent(event: AgentEvent): void {
  switch (event.kind) {
    case "thinking":
      for (const line of event.text.split("\n")) {
        if (line.trim()) console.log(`  ${dim("│")} ${line}`);
      }
      break;

    case "listed":
      console.log(`  ${grey("⋯")} discovered ${event.count} services`);
      break;

    case "checked":
      if (!event.allowed) {
        console.log(
          `  ${grey("?")} pre-check ${event.label} ${grey(formatUsdc(event.amount))} → ` +
            `${red(reasonName(event.reason))}`,
        );
      }
      break;

    case "paid":
      console.log(
        `  ${green("✓")} ${bold("PAID")}     ${event.label} ${bold(formatUsdc(event.amount))}`,
      );
      console.log(`    ${dim(event.explorerUrl)}`);
      break;

    case "refused":
      console.log(
        `  ${red("✕")} ${red(bold("REFUSED"))}  ${event.label} ${bold(formatUsdc(event.amount))}`,
      );
      console.log(`    ${red(reasonName(event.reason))} ${grey("—")} ${grey(event.message)}`);
      break;

    case "escalated":
      console.log(`  ${amber("↑")} ${bold("ESCALATED")} to owner: ${event.label}`);
      console.log(`    ${grey(event.why)}`);
      break;
  }
}

export function meter(label: string, used: bigint, total: bigint, width = 28): string {
  if (total === 0n) return `${label}: —`;
  const filled = Number((used * BigInt(width)) / total);
  const bar = "█".repeat(Math.min(filled, width)) + dim("░".repeat(Math.max(0, width - filled)));
  return `${grey(label.padEnd(18))} ${bar} ${formatUsdc(used)} / ${formatUsdc(total)}`;
}
