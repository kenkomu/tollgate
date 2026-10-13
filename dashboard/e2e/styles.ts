import {readFile, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {resolve} from "node:path";
import {chromium} from "playwright-core";

/**
 * A computed-style snapshot of every route, for refactoring CSS without changing it.
 *
 *   node e2e/styles.ts snapshot before.json
 *   ...move rules around...
 *   node e2e/styles.ts snapshot after.json
 *   node e2e/styles.ts diff before.json after.json
 *
 * Screenshots cannot do this job: the pages show live chain data and relative times, so two
 * captures a minute apart never match. Computed styles ignore the text and report what the
 * cascade actually resolved, which is exactly what a stylesheet reorganisation must not change.
 * Motion is reduced so no element is caught mid-animation.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ROUTES = ["/", "/activity", "/activity?filter=refused", "/payees", "/policy", "/welcome"];
const WIDTHS = [390, 1280];
const SCHEMES = ["dark", "light"] as const;

// What a reorganisation could plausibly disturb. Inherited text metrics included, since a
// moved rule can change what a child inherits.
const PROPS = [
  "display", "position", "top", "right", "bottom", "left", "z-index",
  "width", "max-width", "min-height", "margin", "padding", "gap",
  "grid-template-columns", "flex-direction", "flex-wrap", "align-items", "justify-content",
  "color", "background-color", "background-image", "border", "border-radius", "box-shadow", "outline",
  "opacity", "transform", "overflow", "visibility",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-transform",
  "text-align", "text-decoration-line", "white-space", "font-variant-numeric",
];

type Snapshot = Record<string, string[]>;

async function snapshot(out: string) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/snap/bin/chromium",
    args: ["--no-sandbox"],
    env: {...process.env, TMPDIR: resolve(homedir(), "snap")},
  });
  const result: Snapshot = {};
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      for (const scheme of SCHEMES) {
        const page = await browser.newPage({viewport: {width, height: 900}, colorScheme: scheme, reducedMotion: "reduce"});
        await page.goto(BASE + route, {waitUntil: "commit", timeout: 90_000});
        await page.waitForLoadState("load", {timeout: 60_000}).catch(() => undefined);
        // Streamed sections resolve after load; wait until no skeleton is left.
        await page.waitForFunction(() => !document.querySelector(".skeleton, .sk"), null, {timeout: 60_000}).catch(() => undefined);
        await page.waitForTimeout(1_000);
        result[`${route} @${width} ${scheme}`] = await page.evaluate((props) => {
          const path = (el: Element): string => {
            const parts: string[] = [];
            for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
              const cls = [...e.classList].sort().join(".");
              parts.unshift(`${e.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`);
            }
            return parts.join(">");
          };
          const rows: string[] = [];
          for (const el of document.body.querySelectorAll("*")) {
            // Chart internals are sized by live data, not by the stylesheet.
            if (el.closest("script, style, template, next-route-announcer, svg.chart > *")) continue;
            const cs = getComputedStyle(el);
            const before = getComputedStyle(el, "::before");
            const pseudo = before.content !== "none" ? ` ::before{${before.content};${before.color}}` : "";
            rows.push(`${path(el)} ${props.map((p) => cs.getPropertyValue(p)).join("|")}${pseudo}`);
          }
          return rows;
        }, PROPS);
        await page.close();
        process.stdout.write(".");
      }
    }
  }
  await browser.close();
  await writeFile(out, JSON.stringify(result));
  console.log(`\n${Object.keys(result).length} views → ${out}`);
}

async function diff(a: string, b: string) {
  const left = JSON.parse(await readFile(a, "utf8")) as Snapshot;
  const right = JSON.parse(await readFile(b, "utf8")) as Snapshot;
  let changed = 0;
  for (const view of Object.keys(left)) {
    const l = left[view] ?? [];
    const r = right[view] ?? [];
    if (l.length !== r.length) {
      // Different element counts usually means different data, not different CSS.
      console.log(`${view}: ${l.length} vs ${r.length} elements (data changed?), comparing the common styles`);
    }
    const counts = new Map<string, number>();
    for (const row of l) counts.set(row, (counts.get(row) ?? 0) + 1);
    const extra: string[] = [];
    for (const row of r) {
      const n = counts.get(row) ?? 0;
      if (n > 0) counts.set(row, n - 1);
      else extra.push(row);
    }
    const missing = [...counts].flatMap(([row, n]) => Array<string>(n).fill(row));
    if (l.length === r.length && extra.length === 0) continue;
    if (l.length === r.length || extra.length > 0) {
      changed += extra.length;
      console.log(`${view}: ${extra.length} element styles differ`);
      for (const row of extra.slice(0, 3)) {
        const key = row.split(" ")[0]!;
        console.log(`  after : ${row.slice(0, 400)}`);
        const was = missing.find((m) => m.startsWith(`${key} `));
        if (was) console.log(`  before: ${was.slice(0, 400)}`);
      }
    }
  }
  console.log(changed === 0 ? "No computed style changed." : `${changed} element styles changed.`);
  process.exit(changed === 0 ? 0 : 1);
}

const [command, ...args] = process.argv.slice(2);
if (command === "snapshot") await snapshot(args[0] ?? "styles.json");
else if (command === "diff") await diff(args[0]!, args[1]!);
else console.log("usage: node e2e/styles.ts snapshot <out.json> | diff <before.json> <after.json>");
