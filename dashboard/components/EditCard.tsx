"use client";

import {useId, useState, useTransition, type ReactNode} from "react";
import {useRouter} from "next/navigation";
import type {WriteResult} from "../lib/owner.ts";
import type {Check} from "../lib/policy-form.ts";
import {txUrl} from "../lib/chain.ts";
import {activeChain} from "@tollgate/shared";
import {ExternalIcon} from "./Icon.tsx";

/**
 * One editable rule.
 *
 * Every policy change shares the same three-state life — idle, signing, settled — and the
 * same obligation to say what it did on chain. Writing that seven times would guarantee
 * seven slightly different answers to "did it work?", so it lives here once.
 *
 * The submit button stays disabled while nothing has changed. An owner clicking "Save" on
 * a form they have not edited should not be charged gas to write the values that are
 * already there.
 */
export function EditCard({
  title,
  note,
  action,
  children,
  submitLabel = "Save",
  danger = false,
  dirty = true,
  confirm,
}: {
  title: string;
  note: ReactNode;
  action: () => Promise<WriteResult>;
  children?: ReactNode;
  submitLabel?: string;
  danger?: boolean;
  /** False when the form still holds its original values. */
  dirty?: boolean;
  /** Required phrase for irreversible actions. */
  confirm?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<WriteResult | null>(null);
  const [typed, setTyped] = useState("");
  const [acked, setAcked] = useState(false);

  // On mainnet every write moves or authorises real USDC, so the first click is a statement
  // of intent rather than a reflex. Testnet stays frictionless.
  const needsAck = !activeChain.testnet;
  const locked = (confirm !== undefined && typed.trim() !== confirm) || (needsAck && !acked);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setResult(null);
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      // The write happened in this browser, so the server has no idea anything changed.
      // `revalidatePath` did this when these were server actions; now the client asks.
      if (outcome.ok) router.refresh();
    });
  }

  return (
    <form className={`card edit${danger ? " danger-zone" : ""}`} onSubmit={submit}>
      <h3 className="edit-title">{title}</h3>
      <p className="card-note">{note}</p>

      {children ? <div className="fields">{children}</div> : null}

      {confirm !== undefined ? (
        <label className="field">
          <span>
            Type <code>{confirm}</code> to confirm
          </span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
      ) : null}

      {needsAck ? (
        <label className="ack">
          <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
          <span>I understand this signs a real transaction on Arc mainnet.</span>
        </label>
      ) : null}

      <div className="actions">
        <button
          type="submit"
          className={danger ? "danger" : "primary"}
          disabled={pending || locked || !dirty}
        >
          {pending ? "Signing…" : submitLabel}
        </button>
        {!dirty && !pending ? <span className="hint">No changes</span> : null}
      </div>

      {result?.ok ? (
        <p className="edit-ok">
          Written to chain.{" "}
          {result.hash ? (
            <a href={txUrl(result.hash)} target="_blank" rel="noreferrer">
              proof <ExternalIcon size={11} />
            </a>
          ) : null}
        </p>
      ) : null}
      {result && !result.ok ? <p className="error">{result.error}</p> : null}
    </form>
  );
}

/**
 * A labelled input. Units live in the label, never as placeholder text inside the box.
 *
 * A `check` outranks a `hint`: when something is wrong, the owner reads why rather than the
 * generic help text, and an error marks the input invalid for assistive technology too.
 */
export function Field({
  label,
  hint,
  check,
  ...props
}: {label: string; hint?: string; check?: Check} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const message = check?.message ?? hint;
  const tone = check ? ` ${check.level}` : "";
  return (
    <label className="field">
      <span>{label}</span>
      <input
        {...props}
        aria-invalid={check?.level === "error" ? true : undefined}
        aria-describedby={message ? id : undefined}
      />
      {message ? (
        <small id={id} className={tone.trim() || undefined}>
          {message}
        </small>
      ) : null}
    </label>
  );
}
