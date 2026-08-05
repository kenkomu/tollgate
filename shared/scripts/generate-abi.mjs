#!/usr/bin/env node
/**
 * Regenerates shared/src/abi.ts from the compiled Foundry artifact.
 *
 * Run after any change to PolicyEngine.sol:
 *   pnpm contracts:build && pnpm --filter @tollgate/shared abi
 *
 * The ABI is generated rather than hand-maintained so the TypeScript view of the
 * contract cannot drift from what is actually deployed.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = resolve(here, "../../enforcement/out/PolicyEngine.sol/PolicyEngine.json");
const outPath = resolve(here, "../src/abi.ts");

let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch {
  console.error(`Could not read ${artifactPath}`);
  console.error("Build the contracts first:  pnpm contracts:build");
  process.exit(1);
}

const header = `// GENERATED FILE — do not edit by hand.
// Regenerate with:  pnpm --filter @tollgate/shared abi
//
// Source: enforcement/out/PolicyEngine.sol/PolicyEngine.json
// This is generated rather than hand-written so the TypeScript view of the contract
// cannot drift from the compiled artifact. Drift here would mean the dashboard
// mislabelling a blocked payment in an audit log, which is the one thing this
// product cannot get wrong.

export const policyEngineAbi = `;

writeFileSync(outPath, header + JSON.stringify(artifact.abi, null, 2) + " as const;\n");

const count = (type) => artifact.abi.filter((e) => e.type === type).length;
console.log(
  `abi.ts regenerated: ${count("function")} functions, ${count("event")} events, ${count("error")} errors`,
);
