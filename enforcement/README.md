# enforcement/

**This is the trust core.** Everything else in the repository is convenience and can be
rebuilt from chain state. This cannot.

## What must never break here

1. **`spent` never exceeds `budgetCap`.** The headline guarantee.
2. **This contract never holds funds.** There is no deposit and no withdraw. Its USDC
   balance must be zero at every point in time.
3. **A refused spend moves nothing and records nothing.** Refusal is atomic.
4. **The kill switch works without us.** `setPaused(true)` is a direct owner-to-chain
   write with no backend, indexer, or relayer in the path. It must keep working when every
   other part of Tollgate is down.
5. **The owner can always leave.** `approve(engine, 0)` on USDC ends the relationship
   without this contract's cooperation.

Each of these is an executable invariant in `test/invariant/`, not a comment.

## Layout

```
src/PolicyEngine.sol                     the whole enforcement surface
test/PolicyEngine.t.sol                  every reason code, both sides of every cap
test/invariant/Handler.sol               drives random owner/agent/time sequences
test/invariant/PolicyEngineInvariants.t.sol   the properties above
test/invariant/HandlerDebug.t.sol        proves the campaign isn't vacuous
test/mocks/MockUSDC.sol                  6-decimal stand-in for Arc's USDC
```

## Running

```sh
forge test              # everything
forge test -vv          # with the coverage and reason-code report
FOUNDRY_PROFILE=ci forge test   # 10k fuzz runs, 1024 invariant runs
```

## A note on vacuous invariants

An early version of the invariant handler produced **zero successful spends across 32,768
calls** while all eight invariants passed. "Spent never exceeds budget" is trivially true
when nothing is ever spent — the suite was green and proved nothing.

`HandlerDebugTest.test_handlerReachesBothBranchesAtScale` exists to stop that recurring: it
drives the handler deterministically and fails if either the permitted or the refused path
is starved. `afterInvariant` prints the same numbers per run for visibility, but does not
assert on them — Foundry resets handler state between runs, so an unlucky sequence
legitimately reaches no spend and asserting there would only make the suite flaky.

If you change the handler's bounds, check the reason-code histogram afterwards.

## Deploying

Per [docs.arc.io/arc/tutorials/deploy-on-arc](https://docs.arc.io/arc/tutorials/deploy-on-arc).

Fund the deployer first — on Arc, USDC *is* gas, so one faucet claim covers everything:
[faucet.circle.com](https://faucet.circle.com), select Arc Testnet.

```sh
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.io \
  --broadcast
```

Then verify. ArcScan runs Blockscout, so this needs `--verifier blockscout` rather than
the Etherscan default, and `PolicyEngine` takes a constructor argument:

```sh
forge verify-contract $POLICY_ENGINE_ADDRESS src/PolicyEngine.sol:PolicyEngine \
  --chain-id 5042002 \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api/ \
  --constructor-args $(cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000)
```

If a transaction sticks, check the gas price. Arc's testnet base fee floor is **20 Gwei**
and the docs warn that anything below it "may remain pending indefinitely or fail
outright". `foundry.toml` sets a 25 Gwei floor; add `--with-gas-price 30gwei` if the
network is busy.

## Arc specifics

- Compile to **`cancun`**, not `paris`. Arc targets the Osaka hard fork and runs reth;
  Circle's own ERC-8183 reference proxy executes PUSH0 on every call. We want `cancun` for
  transient storage, which is what `ReentrancyGuardTransient` uses.
- Every amount here is **6-decimal** ERC-20 USDC. Arc's *native* USDC is 18 decimals for
  gas accounting. This contract never reads a native balance, and neither should anything
  that calls it.
- USDC ERC-20 predeploy: `0x3600000000000000000000000000000000000000`.
