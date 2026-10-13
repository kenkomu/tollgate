"use client";

import {useEffect, useRef, useState} from "react";
import {useRouter} from "next/navigation";

/**
 * Keeps the page current without a reload.
 *
 * The demo is a conversation between two windows: the agent pays in a terminal, and the
 * owner watches it land here. That only reads as *enforcement* if the row appears on its
 * own — asking the audience to hit refresh turns a live control plane back into a report.
 *
 * `router.refresh()` re-runs the server render, so the numbers still come from chain and
 * nothing is held client-side. Settled history is memoised on the server, so a refresh
 * costs one `eth_getLogs` for the tip window rather than a full re-walk.
 *
 * Polling stops while the tab is hidden. A background tab quietly consuming a public RPC
 * endpoint is how you get rate-limited halfway through a demo.
 */
const STREAM_URL = process.env.NEXT_PUBLIC_TOLLGATE_SERVICE_URL
  ? `${process.env.NEXT_PUBLIC_TOLLGATE_SERVICE_URL.replace(/\/$/, "")}/stream`
  : "";

/**
 * Push when the service is reachable, poll when it is not.
 *
 * With the service running, the page re-renders only when the contract actually emitted
 * something (the service watches the tip for everyone), so an idle tab makes no requests at
 * all. Without it, or if the stream drops, this falls back to the old visibility-aware poll.
 * The stream carries no numbers, only "re-read", so the page still gets every figure from the
 * chain and the index exactly as before.
 */
export function LiveRefresh({seconds = 12}: {seconds?: number}) {
  const router = useRouter();
  const [live, setLive] = useState(true);
  const [mode, setMode] = useState<"push" | "poll">("poll");
  const [age, setAge] = useState(0);
  const lastRefresh = useRef(0);

  useEffect(() => {
    if (!live) return;
    lastRefresh.current = Date.now();

    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const refresh = () => {
      lastRefresh.current = Date.now();
      router.refresh();
    };

    const startPolling = () => {
      setMode("poll");
      poll ??= setInterval(() => {
        if (document.visibilityState === "visible") refresh();
      }, seconds * 1000);
    };

    if (STREAM_URL && typeof EventSource !== "undefined") {
      source = new EventSource(STREAM_URL);
      source.addEventListener("open", () => {
        setMode("push");
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
      });
      source.addEventListener("changed", refresh);
      // EventSource reconnects on its own; poll in the meantime so the page never goes stale.
      source.addEventListener("error", startPolling);
    } else {
      startPolling();
    }

    const ageTimer = setInterval(() => {
      setAge(Math.floor((Date.now() - lastRefresh.current) / 1000));
    }, 1000);

    return () => {
      source?.close();
      if (poll) clearInterval(poll);
      clearInterval(ageTimer);
    };
  }, [live, seconds, router]);

  const label = !live ? "paused" : mode === "push" ? "live" : age < 3 ? "live" : `live · ${age}s`;

  return (
    <button
      type="button"
      className="live"
      onClick={() => setLive((on) => !on)}
      aria-pressed={live}
      title={
        !live
          ? "Resume live updates"
          : mode === "push"
            ? "Updates the moment the contract emits an event"
            : `Refreshing every ${seconds}s (live stream unavailable)`
      }
    >
      <span className={`live-dot${live ? "" : " off"}`} aria-hidden="true" />
      {label}
    </button>
  );
}
