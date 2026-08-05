/**
 * @tollgate/shared
 *
 * The single source of truth every TypeScript package imports: contract ABI, reason
 * codes, chain config, and the amount helpers that keep USDC's two decimal conventions
 * from ever meeting.
 *
 * The rule this package exists to enforce: nothing outside `enforcement/` may hard-code
 * a contract address, an ABI fragment, a reason code, or a decimal count. If it needs
 * one, it imports it from here.
 */
export * from "./abi.ts";
export * from "./amounts.ts";
export * from "./chain.ts";
export * from "./policy.ts";
export * from "./reasons.ts";
