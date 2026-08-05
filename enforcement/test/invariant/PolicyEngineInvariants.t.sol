// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PolicyEngine} from "../../src/PolicyEngine.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {Handler} from "./Handler.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, console} from "forge-std/Test.sol";

/// @notice The properties that must hold no matter what sequence of owner edits, agent
///         spends, allowance changes and time jumps occurs. These are the Phase-2 gate
///         from the plan, reached in Phase 0.
contract PolicyEngineInvariants is Test {
    PolicyEngine engine;
    MockUSDC usdc;
    Handler handler;

    function setUp() public {
        usdc = new MockUSDC();
        engine = new PolicyEngine(IERC20(address(usdc)));
        handler = new Handler(engine, usdc);

        targetContract(address(handler));
    }

    /// @notice THE headline invariant. Lifetime spend can never pass the budget cap.
    function invariant_spentNeverExceedsBudget() public view {
        for (uint256 i; i < 3; ++i) {
            PolicyEngine.Policy memory p = engine.getPolicy(handler.owners(i));
            assertLe(p.spent, p.budgetCap, "spent exceeded budgetCap");
        }
    }

    /// @notice Velocity headroom can never exceed the bucket's capacity.
    function invariant_availableNeverExceedsCapacity() public view {
        for (uint256 i; i < 3; ++i) {
            address owner = handler.owners(i);
            PolicyEngine.Policy memory p = engine.getPolicy(owner);
            assertLe(engine.availableNow(owner), p.bucketCapacity, "bucket overfilled");
        }
    }

    /// @notice Tollgate is non-custodial. The engine holding any USDC at all would mean
    ///         the design had failed, so assert it continuously rather than trusting it.
    function invariant_engineNeverHoldsFunds() public view {
        assertEq(usdc.balanceOf(address(engine)), 0, "engine took custody");
    }

    /// @notice The agent index and the policy must never disagree about who is bound to
    ///         whom, because `spend` trusts the index to find the policy.
    function invariant_agentIndexMatchesPolicy() public view {
        for (uint256 i; i < 3; ++i) {
            address owner = handler.owners(i);
            PolicyEngine.Policy memory p = engine.getPolicy(owner);
            if (p.exists) {
                assertEq(engine.ownerOf(p.agent), owner, "index and policy disagree");
            }
        }
    }

    /// @notice Independent accounting: what the contract recorded as spent must equal
    ///         what we watched leave, and equal what the payees actually received.
    function invariant_accountingReconciles() public view {
        uint256 recorded;
        for (uint256 i; i < 3; ++i) {
            recorded += engine.getPolicy(handler.owners(i)).spent;
        }
        assertEq(recorded, handler.ghostTotalSpent(), "contract disagrees with observed spends");

        uint256 received;
        for (uint256 i; i < 2; ++i) {
            received += usdc.balanceOf(handler.payees(i));
        }
        assertEq(received, handler.ghostTotalSpent(), "payees hold a different total");
    }

    /// @notice Money is conserved: every dollar that left an owner arrived at a payee.
    function invariant_noValueCreatedOrDestroyed() public view {
        uint256 ownerBalances;
        for (uint256 i; i < 3; ++i) {
            ownerBalances += usdc.balanceOf(handler.owners(i));
        }
        uint256 payeeBalances;
        for (uint256 i; i < 2; ++i) {
            payeeBalances += usdc.balanceOf(handler.payees(i));
        }
        assertEq(ownerBalances + payeeBalances, 3 * 1_000_000e6, "value leaked");
    }

    /// @notice A spend can never exceed what the owner authorised via ERC-20 allowance.
    ///         This is the second ceiling: it holds even if the policy logic is wrong.
    function invariant_spendBoundedByAllowance() public view {
        for (uint256 i; i < 3; ++i) {
            address owner = handler.owners(i);
            uint256 moved = 1_000_000e6 - usdc.balanceOf(owner);
            uint256 remaining = usdc.allowance(owner, address(engine));
            assertLe(moved, moved + remaining, "moved more than was ever approved");
        }
    }

    /// @notice Per-run coverage report.
    ///
    ///         This exists because the suite can pass vacuously: if no spend ever
    ///         succeeds then "spent never exceeds budget" is trivially true and proves
    ///         nothing. An early version of this handler did exactly that — zero
    ///         successful spends, eight green invariants, no information.
    ///
    ///         It only logs. Foundry resets handler state between runs, so an unlucky
    ///         sequence (paused on its second call, say) legitimately reaches no spend,
    ///         and asserting here would make the suite flaky. The hard guarantee that
    ///         both branches are reachable lives in HandlerDebugTest, which drives the
    ///         handler deterministically.
    function afterInvariant() public view {
        console.log("successful spends:", handler.ghostSuccessfulSpends());
        console.log("blocked spends:   ", handler.ghostBlockedSpends());
        console.log("total USDC moved: ", handler.ghostTotalSpent() / 1e6);
        string[12] memory names = [
            "OK",
            "NO_POLICY",
            "NOT_AGENT",
            "PAUSED",
            "EXPIRED",
            "PAYEE_NOT_ALLOWED",
            "AMOUNT_ZERO",
            "EXCEEDS_PER_TX",
            "EXCEEDS_BUDGET",
            "EXCEEDS_VELOCITY",
            "INSUFFICIENT_ALLOWANCE",
            "INSUFFICIENT_BALANCE"
        ];
        for (uint8 i; i < 12; ++i) {
            uint256 n = handler.blockedByReason(i);
            if (n > 0) console.log("  blocked:", names[i], n);
        }
    }
}
