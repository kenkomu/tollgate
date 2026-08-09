import {useCallback, useEffect, useState} from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {formatUsdc, formatUsdcApprox, type Activity} from "@tollgate/shared";
import {
  ActivityRow,
  Button,
  Card,
  Freshness,
  Meter,
  Note,
  Offline,
  Title,
  timeAgo,
} from "./src/components.tsx";
import {KillSwitch} from "./src/KillSwitch.tsx";
import {isConfigured, readPolicy, type LivePolicy} from "./src/chain.ts";
import {
  freshnessOf,
  getActivity,
  getApprovals,
  getHealth,
  resolveApproval,
  type Approval,
  type Health,
} from "./src/api.ts";
import {mono, shortAddress, useTheme} from "./src/theme.ts";

/**
 * Tollgate, in a pocket.
 *
 * Three screens, chosen because they are the three things an owner cannot wait to get to a
 * laptop for: stop the agent, answer an approval it is blocked on, and see what happened.
 * Policy editing stays on the web for now — ADR 0007 leaves that open, and putting a
 * velocity-limit rewrite one tap from a lock screen is not obviously right.
 *
 * The structural decision worth naming: **policy state is read from the chain, history from
 * our service.** The limits this screen shows are the limits the contract will enforce,
 * because they came from the contract. If our backend is down, wrong, or hostile, the numbers
 * that matter are unaffected — and the app says plainly when it cannot reach either one.
 */

type Tab = "now" | "approvals" | "activity";

export default function App() {
  const t = useTheme();
  const [tab, setTab] = useState<Tab>("now");

  const [policy, setPolicy] = useState<LivePolicy | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [entries, setEntries] = useState<Activity[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);

  const [chainDown, setChainDown] = useState(false);
  const [serviceDown, setServiceDown] = useState(false);
  const [loading, setLoading] = useState(true);

  /**
   * Chain and service are loaded independently, and their failures are reported separately.
   *
   * Collapsing them would hide the case that matters most: the service being unreachable while
   * the chain is fine means history is stale but the *limits are still true*. Telling someone
   * their agent might be unbounded when it demonstrably is not would be its own kind of lie.
   */
  const load = useCallback(async () => {
    const readChain = isConfigured()
      ? readPolicy().then(
          (p) => {
            setPolicy(p);
            setChainDown(false);
          },
          () => setChainDown(true),
        )
      : Promise.resolve();

    const readService = Promise.all([getHealth(), getActivity(50), getApprovals()]).then(
      ([h, a, q]) => {
        setHealth(h);
        setEntries(a.entries);
        setApprovals(q);
        setServiceDown(false);
      },
      () => setServiceDown(true),
    );

    await Promise.all([readChain, readService]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    // Arc settles in under a second, but a phone polling that fast is a battery complaint.
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const fresh = health ? freshnessOf(health) : null;

  return (
    <SafeAreaView style={[styles.safe, {backgroundColor: t.bg}]}>
      <StatusBar barStyle="default" />

      <View style={[styles.header, {borderColor: t.line}]}>
        <Text style={[styles.brand, {color: t.text}]}>Tollgate</Text>
        {policy ? (
          <View style={[styles.chip, {backgroundColor: policy.paused ? t.stopSoft : t.okSoft}]}>
            <Text style={{color: policy.paused ? t.stop : t.ok, fontSize: 11.5, fontWeight: "600"}}>
              {policy.paused ? "Stopped" : "Active"}
            </Text>
          </View>
        ) : null}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
      >
        {!isConfigured() ? (
          <Card>
            <Title>Not configured</Title>
            <Note>
              Set the contract and owner addresses in `app.json` under `expo.extra`, then reload.
            </Note>
          </Card>
        ) : chainDown ? (
          <Offline onRetry={() => void load()} />
        ) : (
          <>
            {/* Staleness, always visible, never implied. */}
            {serviceDown ? (
              <Freshness label="History unavailable — limits below are still live from chain" stale />
            ) : fresh ? (
              <Freshness
                label={fresh.current ? "Up to date" : "Catching up"}
                stale={!fresh.current}
                detail={
                  fresh.secondsBehind !== null && !fresh.current
                    ? `history ${fresh.secondsBehind}s behind`
                    : policy
                      ? `limits read ${timeAgo(Math.floor(policy.readAt / 1000))}`
                      : undefined
                }
              />
            ) : null}

            {tab === "now" ? <NowScreen policy={policy} onRefresh={() => void load()} /> : null}
            {tab === "approvals" ? (
              <ApprovalsScreen
                approvals={approvals}
                down={serviceDown}
                onResolved={() => void load()}
              />
            ) : null}
            {tab === "activity" ? <ActivityScreen entries={entries} down={serviceDown} /> : null}
          </>
        )}
      </ScrollView>

      <View style={[styles.tabs, {borderColor: t.line, backgroundColor: t.surface}]}>
        {(
          [
            ["now", "Now"],
            ["approvals", approvals.length ? `Approvals (${approvals.length})` : "Approvals"],
            ["activity", "Activity"],
          ] as const
        ).map(([id, label]) => (
          <Pressable key={id} onPress={() => setTab(id)} style={styles.tab}>
            <Text style={{color: tab === id ? t.accent : t.muted, fontSize: 13, fontWeight: "600"}}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

function NowScreen({policy, onRefresh}: {policy: LivePolicy | null; onRefresh: () => void}) {
  const t = useTheme();
  if (!policy) return <ActivityIndicator style={{marginTop: 40}} />;

  if (!policy.exists) {
    return (
      <Card>
        <Title>No policy yet</Title>
        <Note>
          This owner has no policy on the contract. Create one from the web dashboard — it takes
          two transactions and about thirty seconds.
        </Note>
      </Card>
    );
  }

  return (
    <>
      <KillSwitch paused={policy.paused} onDone={onRefresh} />

      <Card>
        <Title>The leash</Title>
        <Note>
          Read from the contract by this phone, not from our server. These are the limits that
          will be enforced.
        </Note>

        <Meter
          label="budget used"
          value={policy.spent}
          total={policy.budgetCap}
          sense="used"
          caption={`${formatUsdc(policy.budgetCap - policy.spent)} left of the lifetime budget`}
        />
        <Meter
          label="rate headroom"
          value={policy.headroom}
          total={policy.bucketCapacity}
          sense="remaining"
          caption={`refills about ${formatUsdcApprox(policy.refillPerSecond * 86_400n)} a day`}
        />

        <View style={[styles.kv, {borderColor: t.line}]}>
          <Text style={[styles.k, {color: t.muted}]}>per payment</Text>
          <Text style={[styles.v, mono, {color: t.text}]}>{formatUsdc(policy.perTxCap)}</Text>
        </View>
        <View style={[styles.kv, {borderColor: t.line}]}>
          <Text style={[styles.k, {color: t.muted}]}>agent</Text>
          <Text style={[styles.v, mono, {color: t.text}]}>{shortAddress(policy.agent)}</Text>
        </View>
      </Card>
    </>
  );
}

/**
 * The queue the agent is blocked on.
 *
 * A strict allowlist (ADR 0003) means an agent that meets a new supplier stops until a human
 * answers. If that human is unreachable for hours, the leash has become a productivity tax —
 * and the pressure to loosen the policy "just to be safe" is how these systems end up
 * permissive. This screen is the pressure valve.
 */
function ApprovalsScreen({
  approvals,
  down,
  onResolved,
}: {
  approvals: Approval[];
  down: boolean;
  onResolved: () => void;
}) {
  const t = useTheme();
  const [busy, setBusy] = useState<string | null>(null);

  if (down) {
    return (
      <Card tone="stop">
        <Title>Approvals unavailable</Title>
        <Note>
          Cannot reach the service, so we do not know what your agent is waiting on. Its spending
          limits are unaffected — those live on chain.
        </Note>
      </Card>
    );
  }

  if (approvals.length === 0) {
    return (
      <Card>
        <Title>Nothing waiting on you</Title>
        <Note>Your agent is not blocked on any approval.</Note>
      </Card>
    );
  }

  async function decide(id: string, outcome: "approved" | "declined") {
    setBusy(id);
    try {
      await resolveApproval(id, outcome);
      onResolved();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {approvals.map((request) => (
        <Card key={request.id}>
          <View style={styles.rowTop}>
            <Title>{request.serviceName}</Title>
            <Text style={[styles.v, mono, {color: t.text}]}>{request.amount}</Text>
          </View>
          <Text style={[styles.k, mono, {color: t.muted, marginBottom: 8}]}>
            {shortAddress(request.payee)}
          </Text>
          <Note>{request.why}</Note>

          {/* Said on the screen, not just in a comment: tapping approve does not pay anybody. */}
          <Text style={[styles.k, {color: t.muted, marginBottom: 10}]}>
            Approving records your decision. The payee is only allowlisted once you sign
            setPayee from your wallet — until then the agent stays refused.
          </Text>

          <Button
            label="Approve"
            tone="primary"
            busy={busy === request.id}
            onPress={() => void decide(request.id, "approved")}
          />
          <Button
            label="Decline"
            busy={busy === request.id}
            onPress={() => void decide(request.id, "declined")}
          />
        </Card>
      ))}
    </>
  );
}

function ActivityScreen({entries, down}: {entries: Activity[]; down: boolean}) {
  if (down) {
    return (
      <Card tone="stop">
        <Title>History unavailable</Title>
        <Note>
          Cannot reach the service. This is not an empty log — it is an unknown one, and the two
          must never look the same.
        </Note>
      </Card>
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <Title>Nothing yet</Title>
        <Note>No payments, refusals or policy changes have been recorded.</Note>
      </Card>
    );
  }

  return (
    <Card>
      <Title>Everything that happened</Title>
      <Note>Rebuilt from contract events. Every row is on chain.</Note>
      {entries.map((entry) => (
        <ActivityRow key={entry.key} entry={entry} />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1},
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: {fontSize: 17, fontWeight: "700", letterSpacing: -0.2},
  chip: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20},
  scroll: {padding: 16, paddingBottom: 32},
  tabs: {flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth},
  tab: {flex: 1, alignItems: "center", paddingVertical: 14},
  kv: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  k: {fontSize: 12.5},
  v: {fontSize: 13},
  rowTop: {flexDirection: "row", justifyContent: "space-between", alignItems: "baseline"},
});
