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
  /** Text and icons drawn on the accent fill. */
  onAccent: string;
  ok: string;
  okSoft: string;
  stop: string;
  stopSoft: string;
  /** Text and icons drawn on the stop fill. */
  onStop: string;
  /** Warnings: stale data, notifications off. Amber, so red keeps meaning "blocked". */
  warn: string;
  warnSoft: string;
}

/**
 * Borrowed from Chukua: near-black with one vivid lime accent in dark mode, white with a deep
 * green in light mode, big soft corners, pill controls.
 */
const dark: Theme = {
  bg: "#111111",
  surface: "#000000",
  surface2: "#1a1a1a",
  line: "#232323",
  text: "#fbfbfb",
  muted: "#8c8c8c",
  accent: "#d7fc70",
  accentSoft: "#1d2410",
  onAccent: "#111111",
  ok: "#5fd28a",
  okSoft: "#10231a",
  stop: "#d66b62",
  stopSoft: "#2a1413",
  onStop: "#111111",
  warn: "#ffc62a",
  warnSoft: "#2a2208",
};

const light: Theme = {
  bg: "#ffffff",
  surface: "#f4f6f3",
  surface2: "#ebeeea",
  line: "#e1e5df",
  text: "#111411",
  muted: "#5f655e",
  accent: "#117a43",
  accentSoft: "#e3f1ea",
  onAccent: "#ffffff",
  ok: "#117a43",
  okSoft: "#e3f1ea",
  stop: "#9c332c",
  stopSoft: "#fbe6e3",
  onStop: "#ffffff",
  warn: "#8a5f00",
  warnSoft: "#fff3cf",
};

export const radius = {card: 22, control: 14, pill: 999} as const;

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
