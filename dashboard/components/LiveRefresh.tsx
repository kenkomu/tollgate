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
export function LiveRefresh({seconds = 12}: {seconds?: number}) {
  const router = useRouter();
  const [live, setLive] = useState(true);
  const [age, setAge] = useState(0);

  // Seeded in the effect rather than at `useRef(Date.now())`, because reading the clock
  // during render makes the component impure: the server and the client would seed it at
  // different instants, which is the same class of hydration mismatch SpendChart hit.
  const lastRefresh = useRef(0);

  useEffect(() => {
    if (!live) return;
    lastRefresh.current = Date.now();

    const tick = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      lastRefresh.current = Date.now();
      router.refresh();
    }, seconds * 1000);

    const age = setInterval(() => {
      setAge(Math.floor((Date.now() - lastRefresh.current) / 1000));
    }, 1000);

    return () => {
      clearInterval(tick);
      clearInterval(age);
    };
  }, [live, seconds, router]);

  return (
    <button
      type="button"
      className="live"
      onClick={() => setLive((on) => !on)}
      aria-pressed={live}
      title={live ? "Pause live updates" : "Resume live updates"}
    >
      <span className={`live-dot${live ? "" : " off"}`} aria-hidden="true" />
      {live ? (age < 3 ? "live" : `live · ${age}s`) : "paused"}
    </button>
  );
}
