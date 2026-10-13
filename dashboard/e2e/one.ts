import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {homedir} from "node:os";
import {resolve} from "node:path";
import {chromium} from "playwright-core";
// One page, one width, both schemes: overflow + axe + a screenshot. For checking a single view.
const [url, width = "390", out = "one"] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const axe = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
const browser = await chromium.launch({executablePath: process.env.CHROME_PATH ?? "/snap/bin/chromium", args: ["--no-sandbox"], env: {...process.env, TMPDIR: resolve(homedir(), "snap")}});
for (const scheme of ["dark", "light"] as const) {
  const page = await browser.newPage({viewport: {width: Number(width), height: 900}, colorScheme: scheme});
  await page.goto(url!, {waitUntil: "commit", timeout: 60_000});
  await page.waitForLoadState("domcontentloaded", {timeout: 40_000}).catch(() => undefined);
  await page.addScriptTag({content: axe});
  const v = await page.evaluate(async () => (await (window as any).axe.run(document)).violations.filter((x: any) => ["serious", "critical"].includes(x.impact)).map((x: any) => `${x.id}: ${x.nodes.slice(0, 2).map((n: any) => n.target.join(" ")).join(", ")}`));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(scheme, "overflow", overflow, "axe", v.length ? v : "clean");
  await page.screenshot({path: resolve(homedir(), "claude-shots", `${out}-${scheme}.png`), fullPage: true, timeout: 20_000}).catch(() => console.log("no screenshot"));
}
await browser.close();
