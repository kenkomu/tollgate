import {vi} from "vitest";

/** The owner and contract the forms believe they are editing. */
export const OWNER = "0x00000000000000000000000000000000000c0ffe";
export const ENGINE = "0x00000000000000000000000000000000000e9e9e";
export const AGENT = "0x000000000000000000000000000000000000a9e7";

/**
 * Stand-ins for the owner's wallet writes. Nothing is signed: each records its arguments and
 * reports success, which is all a form can observe of a real write anyway.
 */
export function ownerWrites() {
  const ok = async () => ({ok: true, hash: "0xabc"});
  return {
    setCaps: vi.fn(ok),
    setVelocity: vi.fn(ok),
    setExpiry: vi.fn(ok),
    setAgent: vi.fn(ok),
    setAllowance: vi.fn(ok),
    addPayee: vi.fn(ok),
    revokePolicy: vi.fn(ok),
    createPolicy: vi.fn(ok),
    setPaused: vi.fn(ok),
    approvePayee: vi.fn(ok),
    declineRequest: vi.fn(async () => ({ok: true})),
  };
}

export function chainModule() {
  return {
    OWNER,
    ENGINE,
    txUrl: (hash: string) => `https://explorer.test/tx/${hash}`,
    addressUrl: (address: string) => `https://explorer.test/address/${address}`,
    shortAddress: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
  };
}
