"use client";

import {activeChain} from "@tollgate/shared";
import {createWalletClient, custom, numberToHex, type Address, type EIP1193Provider} from "viem";
import {OWNER} from "./chain.ts";

/**
 * The owner's wallet, in the owner's browser.
 *
 * This replaces a server that held `DEPLOYER_PRIVATE_KEY` and signed on the owner's behalf.
 * That arrangement worked, and it was the one thing in this project that contradicted its
 * own pitch: a product arguing that you should not have to trust an operator, shipped with
 * an operator holding the keys. The contract was always non-custodial; now the application
 * around it is too.
 *
 * Nothing here is a dependency — the injected EIP-1193 provider is a browser API, and viem
 * was already in the tree. The owner signs with a wallet they control, on a chain they
 * chose to add.
 */

export class NoWalletError extends Error {
  constructor() {
    super(
      "No wallet found in this browser. Tollgate asks you to sign owner actions yourself " +
        "rather than holding your key on a server, so a wallet extension is required.",
    );
    this.name = "NoWalletError";
  }
}

export class OwnerMismatchError extends Error {
  constructor(connected: Address, expected: Address) {
    super(
      `This policy belongs to ${expected}, but your wallet is connected as ${connected}. ` +
        `Switch accounts to make changes — the contract will reject writes from any other key.`,
    );
    this.name = "OwnerMismatchError";
  }
}

interface ProviderError {
  code?: number;
  message?: string;
}

function injected(): EIP1193Provider {
  const provider = (globalThis as {ethereum?: EIP1193Provider}).ethereum;
  if (!provider) throw new NoWalletError();
  return provider;
}

/** True when a wallet is present at all — used to render the right empty state. */
export function hasWallet(): boolean {
  return Boolean((globalThis as {ethereum?: EIP1193Provider}).ethereum);
}

/**
 * Put the wallet on Arc, adding the network if it has never seen it.
 *
 * Signing an Arc transaction while pointed at another chain is a class of mistake worth
 * removing entirely rather than warning about: the request would either fail confusingly or,
 * on a chain where the same address exists, do something unintended.
 */
async function ensureArc(provider: EIP1193Provider): Promise<void> {
  const current = (await provider.request({method: "eth_chainId"})) as string;
  if (Number.parseInt(current, 16) === activeChain.id) return;

  const chainId = numberToHex(activeChain.id);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{chainId}],
    } as Parameters<EIP1193Provider["request"]>[0]);
  } catch (error) {
    // 4902: the wallet does not know this chain yet. Arc is new enough that this is the
    // common path rather than the exception, so we offer to add it instead of failing.
    if ((error as ProviderError)?.code !== 4902) throw error;

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: activeChain.name,
          nativeCurrency: activeChain.nativeCurrency,
          rpcUrls: [...activeChain.rpcUrls.default.http],
          blockExplorerUrls: [activeChain.blockExplorers.default.url],
        },
      ],
    } as Parameters<EIP1193Provider["request"]>[0]);
  }
}

/** Prompts for access. Only ever called from a click. */
export async function connect(): Promise<Address> {
  const provider = injected();
  const accounts = (await provider.request({method: "eth_requestAccounts"})) as Address[];
  await ensureArc(provider);
  const account = accounts[0];
  if (!account) throw new NoWalletError();
  return account;
}

/** The connected account, or null. Does not prompt, so it is safe to call on mount. */
export async function currentAccount(): Promise<Address | null> {
  if (!hasWallet()) return null;
  try {
    const accounts = (await injected().request({method: "eth_accounts"})) as Address[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * A wallet client for the owner, or a refusal explaining why not.
 *
 * The owner check is here rather than in the UI because it is the difference between a
 * readable message and a raw contract revert. `PolicyEngine` keys everything on `msg.sender`,
 * so a write from the wrong account does not edit the wrong policy — it fails. Saying which
 * account is connected and which one is needed turns a confusing failure into an instruction.
 */
export async function ownerWallet() {
  const provider = injected();
  const account = (await currentAccount()) ?? (await connect());
  await ensureArc(provider);

  if (OWNER && account.toLowerCase() !== OWNER.toLowerCase()) {
    throw new OwnerMismatchError(account, OWNER);
  }

  return {
    account,
    client: createWalletClient({account, chain: activeChain, transport: custom(provider)}),
  };
}

/** Re-render when the owner switches account or network in their wallet. */
export function watchWallet(onChange: () => void): () => void {
  if (!hasWallet()) return () => {};
  const provider = injected() as EIP1193Provider & {
    on?: (event: string, handler: () => void) => void;
    removeListener?: (event: string, handler: () => void) => void;
  };

  provider.on?.("accountsChanged", onChange);
  provider.on?.("chainChanged", onChange);
  return () => {
    provider.removeListener?.("accountsChanged", onChange);
    provider.removeListener?.("chainChanged", onChange);
  };
}
