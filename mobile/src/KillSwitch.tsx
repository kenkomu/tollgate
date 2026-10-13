import {useState} from "react";
import {Linking, StyleSheet, Text, View} from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import {activeChain} from "@tollgate/shared";
import {Button, Card, Note, Title} from "./components.tsx";
import {ENGINE, OWNER} from "./chain.ts";
import {useTheme} from "./theme.ts";

/**
 * The kill switch.
 *
 * The reason this app exists. Plan §5.1 wants it prominent; ADR 0007 adds that it must be
 * reachable in one tap from a cold start, because the scenario it is for — an agent behaving
 * wrongly — does not wait for anyone to get to a desk.
 *
 * ## Why this hands off to a wallet
 *
 * Pausing is a signed transaction from the owner's key, and this app does not hold that key.
 * It could: generate one, keep it in Keystore, sign here. That would be faster and it would
 * quietly recreate the problem ADR 0008 just removed — a key held by software the owner did
 * not choose, on a device that can be lost, for the single most sensitive action in the system.
 *
 * So the app prepares the transaction and hands it to a wallet the owner already trusts. The
 * biometric gate below is *not* the authorisation — the wallet's own signature is. It is here
 * to stop a pocket-tap or a borrowed phone from opening a signing flow the owner did not mean
 * to start.
 *
 * ## The honest limitation
 *
 * WalletConnect would make this a single in-app flow. Until then, this is a deep link and a
 * fallback that tells the owner exactly what to do — which is worse UX and better than either
 * holding their key or pretending the button does something it does not.
 *
 * ## Every agent, one signature
 *
 * The phone drives the owner-wide switch, `setOwnerPaused`, not a single policy's pause. In
 * the moment this button is for, the owner does not know which agent misbehaved and should not
 * have to find out first. Per-agent pausing lives on the web dashboard.
 */
export function KillSwitch({
  paused,
  agents = 1,
  onDone,
}: {
  /** The owner-wide pause. */
  paused: boolean;
  agents?: number;
  onDone: () => void;
}) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);

  async function confirmItIsYou(): Promise<boolean> {
    const enrolled = await LocalAuthentication.hasHardwareAsync().then(
      async (has) => has && (await LocalAuthentication.isEnrolledAsync()),
    );

    // No biometrics on the device is not a reason to block the kill switch. Someone who needs
    // to stop their agent right now must not be told their phone is not set up correctly.
    if (!enrolled) return true;

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: paused ? "Resume your agents" : "Stop your agents",
      cancelLabel: "Cancel",
    });
    return result.success;
  }

  async function trigger() {
    setError(null);
    setBusy(true);
    try {
      if (!(await confirmItIsYou())) {
        setBusy(false);
        return;
      }

      // The explorer's write tab, prefilled. Any wallet the owner already has can sign there,
      // and the URL is stable and inspectable — no bridge, no session, nothing to expire.
      const url = `${activeChain.blockExplorers.default.url}/address/${ENGINE}/write-contract#setOwnerPaused`;
      const opened = await Linking.canOpenURL(url);
      if (!opened) throw new Error("No browser available to open the contract.");
      await Linking.openURL(url);
      setHandedOff(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card tone={paused ? "stop" : undefined}>
      <Title>{paused ? (agents > 1 ? "Every agent is stopped" : "Agent is stopped") : "Kill switch"}</Title>
      <Note>
        {paused
          ? "Every payment is being refused. Nothing can move until you resume."
          : `Stops every payment${agents > 1 ? ` from all ${agents} agents` : ""} immediately, in one signature. It takes effect on chain, not in this app, so it keeps working even if this app, our servers, and your laptop are all gone.`}
      </Note>

      <Button
        label={busy ? "" : paused ? (agents > 1 ? "Resume all agents" : "Resume agent") : "Stop everything"}
        tone={paused ? "primary" : "danger"}
        onPress={trigger}
        busy={busy}
      />

      {handedOff ? (
        <View style={[styles.handoff, {borderColor: t.line}]}>
          <Text style={[styles.handoffText, {color: t.text}]}>
            Sign <Text style={{fontWeight: "700"}}>setOwnerPaused({paused ? "false" : "true"})</Text> in
            your wallet to finish. Nothing has changed until that transaction lands.
          </Text>
          <Text style={[styles.handoffMeta, {color: t.muted}]}>
            Contract {ENGINE.slice(0, 10)}… · signed by {OWNER.slice(0, 10)}…
          </Text>
          <Button label="Done — check again" onPress={onDone} />
        </View>
      ) : null}

      {error ? <Text style={[styles.error, {color: t.stop}]}>{error}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  handoff: {marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth},
  handoffText: {fontSize: 13, lineHeight: 19, marginBottom: 6},
  handoffMeta: {fontSize: 11.5, marginBottom: 10},
  error: {fontSize: 12.5, marginTop: 10},
});
