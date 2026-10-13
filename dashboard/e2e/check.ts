import {spawn} from "node:child_process";
import {mkdir, readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import {resolve} from "node:path";
import {chromium} from "playwright-core";

/**
 * The UI check: every route, at phone through desktop widths, for the two failures that are
 * easy to ship and hard to notice on a developer's laptop.
 *
 *   - Horizontal overflow. A page wider than the phone scrolls sideways, which on a control
 *     plane for money reads as broken.
 *   - Accessibility. axe-core, failing on "serious" and "critical" findings.
 *
 * Drives the system Chromium (CHROME_PATH, default /snap/bin/chromium) rather than downloading
 * Playwright's own, and serves the production build, so run `next build` first.
 *
 * Screenshots land in e2e/shots/ for a human to look at; they are not compared to anything.
 */

const ROUTES = ["/welcome", "/", "/activity", "/payees", "/policy"];
const WIDTHS = [360, 390, 768, 1280];
const PORT = Number(process.env.CHECK_PORT ?? 3947);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = resolve(import.meta.dirname, "shots");

const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/welcome`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("next start did not come up");
}

const server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORT)], {stdio: "ignore", detached: true});
const stop = () => {
  try {
    process.kill(-server.pid!);
  } catch {
    // already gone
  }
};
process.on("exit", stop);

await waitForServer();
await mkdir(SHOTS, {recursive: true});

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/snap/bin/chromium",
  args: ["--no-sandbox"],
  // A snap-confined Chromium cannot read profiles under /tmp.
  ...(process.env.CHROME_PATH ? {} : {env: {...process.env, TMPDIR: resolve(homedir(), "snap")}}),
});

const failures: string[] = [];
const skippedShots: string[] = [];

for (const scheme of ["dark", "light"] as const) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({viewport: {width, height: 900}, colorScheme: scheme});
    for (const route of ROUTES) {
      // Chain reads can be slow on the public RPC; a page stuck on its skeleton is still a page.
      // "commit", not "domcontentloaded": a streamed page only completes its document once
      // every Suspense boundary resolves, and history reads can be slow on the public RPC. The
      // layout is what is under test; a section still showing its skeleton is still laid out.
      await page.goto(`${BASE}${route}`, {waitUntil: "commit", timeout: 60_000});
      await page.waitForLoadState("domcontentloaded", {timeout: 30_000}).catch(() => undefined);
      await page.waitForLoadState("networkidle", {timeout: 10_000}).catch(() => undefined);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) failures.push(`${route} @${width} ${scheme}: ${overflow}px horizontal overflow`);

      // Contrast is checked in both schemes; everything else once is enough.
      if (width === 390 || width === 1280) {
        await page.addScriptTag({content: axeSource});
        const violations = await page.evaluate(async () => {
          const axe = (window as unknown as {axe: {run: (c: unknown, o: unknown) => Promise<{violations: {id: string; impact: string; nodes: {target: string[]}[]}[]}>}}).axe;
          const result = await axe.run(document, {resultTypes: ["violations"]});
          return result.violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`);
        });
        for (const v of violations) failures.push(`${route} @${width} ${scheme}: ${v}`);
      }

      const name = `${route === "/" ? "overview" : route.slice(1)}-${width}-${scheme}.png`;
      // Best effort: a screenshot waits for fonts, which wait for a streamed document to finish.
      await page.screenshot({path: resolve(SHOTS, name), fullPage: true, timeout: 20_000}).catch(() => {
        skippedShots.push(name);
      });
    }
    await page.close();
  }
}

await browser.close();
stop();

const unique = [...new Set(failures)];
if (unique.length) {
  console.error(`\n${unique.length} UI problem(s):\n  ${unique.join("\n  ")}\n`);
  process.exit(1);
}
if (skippedShots.length) console.log(`(${skippedShots.length} screenshot(s) skipped while history was still loading)`);
console.log(`UI check passed: ${ROUTES.length} routes × ${WIDTHS.length} widths × 2 colour schemes. Screenshots in e2e/shots/.`);
