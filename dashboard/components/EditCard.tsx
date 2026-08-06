"use client";

import {useState, useTransition, type ReactNode} from "react";
import type {WriteResult} from "../lib/owner.ts";
import {txUrl} from "../lib/chain.ts";
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
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<WriteResult | null>(null);
  const [typed, setTyped] = useState("");

  const locked = confirm !== undefined && typed.trim() !== confirm;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setResult(null);
    startTransition(async () => setResult(await action()));
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

/** A labelled input. Units live in the label, never as placeholder text inside the box. */
export function Field({
  label,
  hint,
  ...props
}: {label: string; hint?: string} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
