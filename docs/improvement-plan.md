# Improvement plan — usability, appeal, responsiveness, efficiency, scale

Written 2026-10-13 from a read of the source tree (dashboard, service, mobile, agent, shared),
`BACKLOG.md`, `ROADMAP.md` and ADRs 0006/0008/0009. Findings are what the code does today, not
what the docs hope it does.

## What the code does today (the evidence behind the plan)

| Area | Finding | Source |
|---|---|---|
| Data path | Every dashboard page is `force-dynamic` and rebuilds the audit log from `eth_getLogs` on each request. Settled windows are cached in a JSON file; the tip window is not. | `dashboard/lib/chain.ts`, `logcache.ts`, `app/*/page.tsx` |
| Freshness | `LiveRefresh` calls `router.refresh()` every 12s, re-running the whole server render per open tab. | `components/LiveRefresh.tsx` |
| RPC limits | Public RPC rate-limits with `-32005`; the real `getLogs` span is 20,000 blocks, not the advertised 100,000. | `shared/src/chain.ts` |
| Duplicate backends | `service/` already has a SQLite indexer + API for the phone, but the dashboard doesn't use it. Two code paths compute the same history. | `service/src/*`, ADR 0009 |
| Onboarding | Owner actions need an injected EIP-1193 wallet extension. There is no landing page, no guided first-run, no passkey path. | `lib/wallet.ts`, BACKLOG |
| Auth | None. Whoever reaches the port sees the owner's view (reads only; writes still need the owner's wallet). | BACKLOG |
| Responsive | One 1,358-line `globals.css`; two real breakpoints (899px sidebar, 620px). System fonts, no image weight. Good base, thin tuning. | `app/globals.css` |
| Accessibility | ~11 `aria-`/`role`/`alt` usages across dashboard components. Contrast pass done; keyboard and screen-reader work not. | grep |
| Scale model | One policy per owner, one agent per policy (ADR 0004). A fleet needs N policies. | ADR 0004 |
| Tests | 47 Solidity + ~100 TS. No component tests, no e2e, no load tests. | BACKLOG |

## Principles

1. **The chain stays the authority.** Any cache is a disposable projection (ADR 0006). Current
   limits are never cached.
2. **The kill switch never depends on our servers.** Every change below must keep that true.
3. **Fix the first five minutes before adding features.** A reviewer or design partner decides
   in one session.
4. **Measure before optimising.** Each phase has a number that must move.

---

## Phase A — First impression and first run (1–2 days)

Goal: someone who has never seen the repo understands it and completes one flow unaided.

1. **Landing page** (`/welcome` or a separate static site): the one-sentence claim, the
   compromised-key demo as a 60-second embedded video, a three-step "how it works" diagram,
   and the testnet/mainnet status badge. Reuse `docs/explainer.html` content.
2. **Guided first run** replacing the current empty state: a four-step checklist — connect
   wallet → create policy → approve exact budget → add first payee — with each step showing
   done/not done read from chain. Success looks like a live "ready" state, not a blank page.
3. **Network clarity.** Persistent testnet/mainnet pill (the switch now exists), a confirmation
   modal before the first mainnet write, and a visible "real money" warning on mainnet.
4. **Plain-language pass.** Replace jargon in tiles (`velocity`, `bucket`, `allowance`) with
   a one-line tooltip each; show amounts as `$12.50` first, units second.
5. **Better empty/loading/error states** everywhere; the skeleton work is a good base.

*Metric:* time from clone-and-run to first allowed payment seen in the UI, target under 5 min
with the checklist.

## Phase B — Responsiveness and accessibility (2–3 days)

1. **Mobile-first audit** at 360, 390, 768, 1024, 1440 widths. Add a bottom tab bar under 620px
   instead of the collapsed sidebar; make tables card lists on small screens; 44px touch targets.
2. **Split `globals.css`** into tokens, layout, components (CSS modules or layered files) so
   tuning one surface cannot regress another. Keep zero webfonts (it is a deliberate choice).
3. **Accessibility**: keyboard order through the policy editors, visible focus rings, `aria-live`
   for the live feed and for refusals, labelled form controls, chart text alternatives (data
   table fallback), `prefers-reduced-motion` already honoured. Target axe-core zero serious issues.
4. **Dark/light parity check** and colour-blind-safe status (never red/green alone — add icons).
5. **Component tests** (Testing Library) for the policy editors and feed; Playwright smoke at
   mobile and desktop widths.

*Metric:* Lighthouse accessibility ≥ 95 and no horizontal scroll at 360px on every route.

## Phase C — Speed and efficiency (3–4 days)

The biggest waste is re-walking logs per request, per tab, every 12 seconds.

1. **One read path.** Make the dashboard read history from the `service/` SQLite projection
   (with a chain fallback when the service is down). Keep `getPolicy` reads direct from the
   chain, uncached, as today.
2. **Incremental tip.** The service indexes new blocks once; the dashboard asks "events since
   cursor N" instead of re-querying a window. Idempotency by `tx_hash + log_index` already exists.
3. **Push instead of poll.** Server-Sent Events (or WebSocket) from the service to the browser;
   delete the 12s `router.refresh()` loop. Keep a visibility-aware fallback poll.
4. **Cache headers and streaming.** Static shell + Suspense streaming already started; move
   non-owner-specific pages to `revalidate`, keep policy views dynamic.
5. **RPC hygiene.** Paid or multi-provider RPC with failover (Arc lists several: Alchemy,
   Blockdaemon, dRPC, QuickNode), a request budget per page, and a startup probe of the real
   `getLogs` span instead of the hard-coded 20,000.
6. **Bundle check.** `next build` analyzer; the chart should be the only heavy client module.

*Metrics:* cold dashboard load under 2s on a warm index; zero `getLogs` per page view; a new
payment visible in under 2s without polling.

## Phase D — Hosting, auth and safety for real users (3–5 days)

1. **Deploy** dashboard + service (Fly/Render/Vercel + a volume for SQLite). Add a status page.
2. **Read-only sharing.** Today there is no auth. Add (a) a view-only mode keyed by owner address
   in the URL (data is public anyway) and (b) wallet-signature sign-in (SIWE-style) for anything
   that stores state, such as notification preferences and device tokens.
3. **Rate-limit and validate** the service API; tighten the `access-control-allow-origin: *`
   to known origins for POST routes.
4. **Alerting**: spend spike, pause, budget near ceiling, indexer lag, RPC error rate.
5. **Security page and incident process**, as BACKLOG already calls for.
6. **Mainnet guardrails**: ship with small default budget suggestions and a "never approve max"
   check in the UI that refuses `uint256.max` allowances.

## Phase E — Product scale (1–3 weeks, after design-partner feedback)

Ordered by the BACKLOG's own ranking, filtered for scale:

1. **Multiple agents per owner** (supersedes ADR 0004) — a fleet view with per-agent leashes.
   This is the real scale unlock; everything else is polish next to it.
2. **Batch spend / multicall** — makes sub-$0.05 payments economic.
3. **Policy templates** ("research agent", "procurement agent") to cut setup time.
4. **Per-payee sub-budgets and time windows.**
5. **Package `@tollgate/sdk`** with MCP / LangChain / Vercel AI adapters — this is the
   developer-facing product and the main growth channel.
6. **Postgres swap** behind the existing `Store` interface once there are multiple owners per
   deployment (ADR 0009 already names this trigger).
7. **External audit** before any serious mainnet value; consider Halmos/Certora on `spent ≤ budgetCap`.

---

## Suggested order given the Arc Microgrants deadline

Do first (it shows in the submission): mainnet deploy, **A1–A3** (landing, guided first run,
network clarity), a mobile-width pass on the overview page (**B1**), and the deterministic
attacker script from the BACKLOG so the headline demo is reproducible rather than anecdotal.
Everything else follows after submission.

## Risks to watch

- Moving history to the service adds a dependency to the audit view. Keep the chain fallback,
  or the dashboard becomes something you have to trust.
- SSE/WebSocket must degrade to polling, and the kill switch must stay a direct wallet → chain
  write.
- The Arc docs and public RPC behaviour are evolving; the probed limits (20k logs, 20 gwei floor)
  can change. Re-probe on startup rather than trusting constants.
