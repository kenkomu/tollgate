// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PolicyEngine} from "../../src/PolicyEngine.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives PolicyEngine through random sequences of owner and agent actions.
///         Owners fight the agents; time moves; caps change underneath live policies;
///         keys rotate; owners try to edit each other's policies. The invariants in
///         PolicyEngineInvariants must survive all of it.
///
///         Three owners, two agents each: six policies sharing three wallets, so the
///         cross-agent properties (separate budgets, one shared allowance) are exercised.
contract Handler is CommonBase, StdCheats, StdUtils {
    PolicyEngine public immutable engine;
    MockUSDC public immutable usdc;

    uint256 public constant POLICIES = 6;

    address[3] public owners;
    /// @dev Current key of each policy. Rotation replaces entries, so read it, never cache it.
    address[6] public agents;
    uint256[6] public ids;
    address[2] public payees;

    /// @dev Ghost accounting: what we believe moved, tracked independently of the contract.
    uint256 public ghostTotalSpent;
    uint256 public ghostSuccessfulSpends;
    uint256 public ghostBlockedSpends;
    /// @dev Must stay zero: one owner successfully editing another's policy.
    uint256 public ghostCrossOwnerEdits;
    uint256 private _rotations;

    /// @dev Why spends were refused, keyed by Reason. Diagnostics for the coverage guard:
    ///      when the happy path starves, this says which constraint is doing it.
    mapping(uint8 reason => uint256 count) public blockedByReason;

    constructor(
        PolicyEngine _engine,
        MockUSDC _usdc
    ) {
        engine = _engine;
        usdc = _usdc;

        owners = [makeAddr("owner0"), makeAddr("owner1"), makeAddr("owner2")];
        payees = [makeAddr("payee0"), makeAddr("payee1")];

        for (uint256 i; i < owners.length; ++i) {
            usdc.mint(owners[i], 1_000_000e6);
            vm.prank(owners[i]);
            usdc.approve(address(engine), 200_000e6);
        }
        for (uint256 i; i < POLICIES; ++i) {
            agents[i] = makeAddr(string.concat("agent", vm.toString(i)));
            vm.startPrank(ownerOfPolicy(i));
            ids[i] = engine.createPolicy(agents[i], 100_000e6, 10_000e6, 20_000e6, 1e6, 0);
            engine.setPayee(ids[i], payees[0], true);
            engine.setPayee(ids[i], payees[1], true);
            vm.stopPrank();
        }
    }

    /// @notice Policy i belongs to owner i / 2.
    function ownerOfPolicy(
        uint256 i
    ) public view returns (address) {
        return owners[i / 2];
    }

    function _owner(
        uint256 seed
    ) internal view returns (address) {
        return owners[seed % owners.length];
    }

    function _policy(
        uint256 seed
    ) internal pure returns (uint256) {
        return seed % POLICIES;
    }

    function _payee(
        uint256 seed
    ) internal view returns (address) {
        return payees[seed % payees.length];
    }

    /*//////////////////////////////////////////////////////////////
                              AGENT ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Amounts straddle the 10,000 per-tx cap so both the permitted and refused
    ///      branches are exercised. If this only ever produced refusals the invariants
    ///      would hold vacuously, which is why `afterInvariant` asserts real coverage.
    function spend(
        uint256 agentSeed,
        uint256 payeeSeed,
        uint256 amount
    ) external {
        address agent = agents[_policy(agentSeed)];
        address payee = _payee(payeeSeed);
        amount = bound(amount, 1, 15_000e6);

        uint8 predicted = uint8(engine.checkTransfer(agent, payee, amount));

        vm.prank(agent);
        try engine.spend(payee, amount) {
            ghostTotalSpent += amount;
            ++ghostSuccessfulSpends;
        } catch {
            ++ghostBlockedSpends;
            ++blockedByReason[predicted];
        }
    }

    /*//////////////////////////////////////////////////////////////
                              OWNER ACTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Biased toward running. A fair coin here leaves every policy paused about
    ///      half the time, which starves the success path the invariants need to test.
    function setPaused(
        uint256 policySeed,
        uint256 seed
    ) external {
        uint256 i = _policy(policySeed);
        vm.prank(ownerOfPolicy(i));
        try engine.setPaused(ids[i], seed % 5 == 0) {} catch {}
    }

    /// @dev The fleet switch. Biased harder toward running than `setPaused`, because while it
    ///      is on it refuses two policies at once.
    function setOwnerPaused(
        uint256 ownerSeed,
        uint256 seed
    ) external {
        vm.prank(_owner(ownerSeed));
        engine.setOwnerPaused(seed % 8 == 0);
    }

    function setCaps(
        uint256 policySeed,
        uint128 budgetCap,
        uint128 perTxCap
    ) external {
        budgetCap = uint128(bound(budgetCap, 50_000e6, 500_000e6));
        perTxCap = uint128(bound(perTxCap, 1_000e6, 50_000e6));
        uint256 i = _policy(policySeed);
        vm.prank(ownerOfPolicy(i));
        try engine.setCaps(ids[i], budgetCap, perTxCap) {} catch {}
    }

    function setVelocity(
        uint256 policySeed,
        uint128 capacity,
        uint128 refill
    ) external {
        capacity = uint128(bound(capacity, 5_000e6, 500_000e6));
        refill = uint128(bound(refill, 0, 1_000e6));
        uint256 i = _policy(policySeed);
        vm.prank(ownerOfPolicy(i));
        try engine.setVelocity(ids[i], capacity, refill) {} catch {}
    }

    /// @dev Biased toward allowed, for the same reason `setPaused` is biased toward
    ///      running: an allowlist that is empty most of the time starves the happy path.
    function setPayee(
        uint256 policySeed,
        uint256 payeeSeed,
        uint256 seed
    ) external {
        uint256 i = _policy(policySeed);
        vm.prank(ownerOfPolicy(i));
        try engine.setPayee(ids[i], _payee(payeeSeed), seed % 4 != 0) {} catch {}
    }

    /// @dev Mostly "never expires". Random near-future expiries plus 30-day warps
    ///      otherwise strand every policy permanently past its deadline.
    function setExpiry(
        uint256 policySeed,
        uint64 expiry
    ) external {
        uint64 value =
            expiry % 3 == 0 ? uint64(bound(expiry, block.timestamp, block.timestamp + 365 days)) : 0;
        uint256 i = _policy(policySeed);
        vm.prank(ownerOfPolicy(i));
        try engine.setExpiry(ids[i], value) {} catch {}
    }

    /// @dev Kept mostly sufficient so allowance is not the perpetual binding constraint.
    ///      Zero is still reachable via the owner-exit path in the unit tests.
    function changeAllowance(
        uint256 ownerSeed,
        uint256 newAllowance
    ) external {
        address owner = _owner(ownerSeed);
        newAllowance = bound(newAllowance, 20_000e6, 1_000_000e6);
        vm.prank(owner);
        try usdc.approve(address(engine), newAllowance) {} catch {}
    }

    /// @dev Rotate a policy to a brand-new key. The handler tracks the new key so spends keep
    ///      landing on live agents.
    function rotateAgent(
        uint256 policySeed
    ) external {
        uint256 i = _policy(policySeed);
        address fresh = makeAddr(string.concat("rotated", vm.toString(++_rotations)));
        vm.prank(ownerOfPolicy(i));
        engine.setAgent(ids[i], fresh);
        agents[i] = fresh;
    }

    /// @dev An owner reaching for someone else's policy. Every one of these must revert.
    function crossOwnerEdit(
        uint256 ownerSeed,
        uint256 policySeed,
        uint256 action
    ) external {
        address attacker = _owner(ownerSeed);
        uint256 i = _policy(policySeed);
        if (ownerOfPolicy(i) == attacker) return;
        uint256 id = ids[i];

        vm.startPrank(attacker);
        bool ok;
        if (action % 5 == 0) {
            try engine.setCaps(id, type(uint128).max, type(uint128).max) {
                ok = true;
            } catch {}
        } else if (action % 5 == 1) {
            try engine.setPayee(id, attacker, true) {
                ok = true;
            } catch {}
        } else if (action % 5 == 2) {
            try engine.setAgent(id, attacker) {
                ok = true;
            } catch {}
        } else if (action % 5 == 3) {
            try engine.setPaused(id, false) {
                ok = true;
            } catch {}
        } else {
            try engine.setVelocity(id, type(uint128).max, type(uint128).max) {
                ok = true;
            } catch {}
        }
        vm.stopPrank();
        if (ok) ++ghostCrossOwnerEdits;
    }

    /*//////////////////////////////////////////////////////////////
                                  TIME
    //////////////////////////////////////////////////////////////*/

    function warp(
        uint256 secs
    ) external {
        vm.warp(block.timestamp + bound(secs, 1, 30 days));
    }
}
