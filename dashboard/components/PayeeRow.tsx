"use client";

import {useState, useTransition} from "react";
import type {Address} from "viem";
import {revokePayee} from "../lib/owner.ts";
import {addressUrl, shortAddress, txUrl} from "../lib/chain.ts";
import {ExternalIcon, StopIcon} from "./Icon.tsx";

/**
 * One approved payee, with the way to un-approve them.
 *
 * Revoking is the narrow counterpart to the kill switch: pause stops everything, this
 * stops one counterparty. Both are direct owner-to-chain writes, so neither depends on
 * this app being reachable to take effect.
 */
export function PayeeRow({payee}: {payee: Address}) {
  const [pending, startTransition] = useTransition();
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function revoke() {
    setError(null);
    startTransition(async () => {
      const result = await revokePayee(payee);
      if (result.ok) {
        setHash(result.hash ?? null);
        setDone(true);
      } else {
        setError(result.error ?? "Failed");
      }
    });
  }

  return (
    <div className={`row${done ? " muted" : ""}`}>
      <a className="mono-addr" href={addressUrl(payee)} target="_blank" rel="noreferrer">
        {shortAddress(payee)} <ExternalIcon size={11} />
      </a>

      <div className="actions">
        {done ? (
          <span className="chip stopped">Removed</span>
        ) : (
          <button type="button" onClick={revoke} disabled={pending}>
            <StopIcon size={12} />
            {pending ? "Signing…" : "Revoke"}
          </button>
        )}
      </div>

      {hash ? (
        <a className="row-proof" href={txUrl(hash)} target="_blank" rel="noreferrer">
          proof <ExternalIcon size={11} />
        </a>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
