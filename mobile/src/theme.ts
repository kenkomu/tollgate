import {useColorScheme} from "react-native";

/**
 * The design system, ported from the dashboard.
 *
 * Plan §5.4 asks for one language across surfaces: premium charcoal base, a single confident
 * accent, **red reserved only for blocked and kill**, tabular numerals, restrained motion.
 * Trust is a visual property, and an app that looks like a different product from the web
 * dashboard undermines the thing it is trying to convey.
 *
 * The red discipline is the load-bearing part. If red also means "warning" or "delete" or
 * "unread", it stops meaning "your money was stopped" — and that is the one signal this app
 * exists to deliver.
 */

export interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  ok: string;
  okSoft: string;
  stop: string;
  stopSoft: string;
}

const dark: Theme = {
  bg: "#0e1013",
  surface: "#16191e",
  surface2: "#1b1f25",
  line: "#272c34",
  text: "#e8eaed",
  muted: "#9aa1ac",
  accent: "#6ba3f5",
  accentSoft: "#141c29",
  ok: "#4fa985",
  okSoft: "#12241d",
  stop: "#d66b62",
  stopSoft: "#2a1413",
};

const light: Theme = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  surface2: "#f0f2f5",
  line: "#dfe3e8",
  text: "#12151a",
  muted: "#5c646f",
  accent: "#2c5fa8",
  accentSoft: "#e8eff9",
  ok: "#286b52",
  okSoft: "#e4f0ea",
  stop: "#9c332c",
  stopSoft: "#fbe6e3",
};

export function useTheme(): Theme {
  return useColorScheme() === "light" ? light : dark;
}

/**
 * Tabular numerals, everywhere a number appears.
 *
 * Amounts that shift horizontally as they change are hard to compare down a column and read as
 * unserious in something handling money.
 */
export const mono = {
  fontVariant: ["tabular-nums" as const],
  fontFamily: "monospace",
};

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
