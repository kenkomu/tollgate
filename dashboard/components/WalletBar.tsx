"use client";

import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import type {Address} from "viem";
import {OWNER, shortAddress} from "../lib/chain.ts";
import {connect, currentAccount, hasWallet, watchWallet} from "../lib/wallet.ts";
import {ShieldIcon} from "./Icon.tsx";

/**
 * Who is signing.
 *
 * Deliberately visible on every page rather than tucked into a settings screen, because it
 * answers the question this product is built around: who can actually change this policy.
 * The answer used to be "a private key in a file on the server". Now it is an address the
 * owner controls, shown at all times.
 */
export function WalletBar() {
  const router = useRouter();
  const [account, setAccount] = useState<Address | null>(null);
  const [installed, setInstalled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Sync to the wallet, which is an external system this component does not own.
   *
   * Never prompts — `eth_accounts` returns only what has already been granted, and asking
   * for access on page load is how sites train people to dismiss wallet dialogs without
   * reading them. The state lands in a promise callback rather than in the effect body, so
   * a component unmounted mid-read does not set state afterwards.
   */
  useEffect(() => {
    let live = true;

    const sync = () => {
      currentAccount().then(
        (found) => {
          if (!live) return;
          setInstalled(hasWallet());
          setAccount(found);
        },
        () => {
          if (live) setAccount(null);
        },
      );
    };

    sync();

    const unwatch = watchWallet(() => {
      sync();
      // The server rendered this page for whoever was connected before. If that changed,
      // every policy read on the page is now answering the wrong question.
      router.refresh();
    });

    return () => {
      live = false;
      unwatch();
    };
  }, [router]);

  async function onConnect() {
    setBusy(true);
    setError(null);
    try {
      setAccount(await connect());
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!installed) {
    return (
      <div className="walletbar warn">
        <span>
          No wallet detected. Owner actions are signed in your browser, never on our server —
          so changing this policy needs a wallet extension on Arc.
        </span>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="walletbar">
        <span className="walletbar-text">
          Connect to sign owner actions. Your key never leaves your wallet.
        </span>
        <button type="button" className="primary" onClick={onConnect} disabled={busy}>
          {busy ? "Connecting…" : "Connect wallet"}
        </button>
        {error ? <span className="error">{error}</span> : null}
      </div>
    );
  }

  const mismatch = Boolean(OWNER) && account.toLowerCase() !== OWNER.toLowerCase();

  if (mismatch) {
    return (
      <div className="walletbar warn">
        <span>
          Connected as <code>{shortAddress(account)}</code>, but this policy belongs to{" "}
          <code>{shortAddress(OWNER)}</code>. You can read everything; the contract will
          refuse any change signed by another key.
        </span>
      </div>
    );
  }

  return (
    <div className="walletbar ok">
      <ShieldIcon size={12} />
      <span className="walletbar-text">
        Signing as <code>{shortAddress(account)}</code> — this key, not our server, controls
        this policy.
      </span>
    </div>
  );
}
