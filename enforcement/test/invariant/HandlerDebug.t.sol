// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PolicyEngine} from "../../src/PolicyEngine.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {Handler} from "./Handler.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test, console} from "forge-std/Test.sol";

/// @notice Scratch harness proving the Handler can reach a successful spend at all.
///         Kept in the suite so a future change that starves the happy path is caught
///         by a readable unit failure rather than only by the coverage guard.
contract HandlerDebugTest is Test {
    PolicyEngine engine;
    MockUSDC usdc;
    Handler handler;

    function setUp() public {
        usdc = new MockUSDC();
        engine = new PolicyEngine(IERC20(address(usdc)));
        handler = new Handler(engine, usdc);
    }

    function test_handlerStateIsSane() public view {
        address owner0 = handler.owners(0);
        address agent0 = handler.agents(0);
        address payee0 = handler.payees(0);
        uint256 id0 = handler.ids(0);

        PolicyEngine.Policy memory p = engine.getPolicy(id0);
        console.log("policy exists   :", p.exists);
        console.log("policy agent    :", p.agent);
        console.log("expected agent  :", agent0);
        console.log("ownerOf(agent0) :", engine.ownerOf(agent0));
        console.log("budgetCap       :", p.budgetCap / 1e6);
        console.log("perTxCap        :", p.perTxCap / 1e6);
        console.log("bucketCapacity  :", p.bucketCapacity / 1e6);
        console.log("availableNow    :", engine.availableNow(id0) / 1e6);
        console.log("owner balance   :", usdc.balanceOf(owner0) / 1e6);
        console.log("allowance       :", usdc.allowance(owner0, address(engine)) / 1e6);
        console.log("payee0 allowed  :", engine.isAllowedPayee(id0, payee0));
        console.log("checkTransfer   :", uint256(engine.checkTransfer(agent0, payee0, 1_000e6)));
    }

    function test_handlerSpendSucceedsOnce() public {
        handler.spend(0, 0, 1_000e6);
        console.log("successful:", handler.ghostSuccessfulSpends());
        console.log("blocked   :", handler.ghostBlockedSpends());
        assertGt(handler.ghostSuccessfulSpends(), 0, "handler cannot reach a successful spend");
    }

    /// @notice The real coverage guarantee for the invariant campaign.
    ///
    ///         Invariants that only ever observe refused spends are vacuous — "spent
    ///         never exceeds budget" is trivially true when nothing is ever spent. This
    ///         drives the handler through a deterministic pseudo-random sequence and
    ///         insists both branches are reached often enough to mean something.
    ///
    ///         It lives here rather than in `afterInvariant` because Foundry resets
    ///         handler state between runs, so a per-run assertion would be flaky.
    function test_handlerReachesBothBranchesAtScale() public {
        uint256 seed = uint256(keccak256("tollgate"));

        for (uint256 i; i < 400; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = seed % 12;

            if (action < 6) {
                handler.spend(seed, seed >> 8, seed >> 16);
            } else if (action == 6) {
                handler.warp(seed >> 24);
            } else if (action == 7) {
                handler.setPaused(seed, seed >> 32);
            } else if (action == 8) {
                handler.setPayee(seed, seed >> 40, seed >> 48);
            } else if (action == 9) {
                handler.setVelocity(seed, uint128(seed >> 56), uint128(seed >> 64));
            } else if (action == 10) {
                handler.rotateAgent(seed >> 72);
            } else {
                handler.crossOwnerEdit(seed, seed >> 80, seed >> 88);
            }
        }

        uint256 ok = handler.ghostSuccessfulSpends();
        uint256 blocked = handler.ghostBlockedSpends();
        console.log("successful:", ok);
        console.log("blocked   :", blocked);
        console.log("USDC moved:", handler.ghostTotalSpent() / 1e6);

        assertGt(ok, 20, "happy path is starved: invariants would be near-vacuous");
        assertGt(blocked, 20, "refusal path is starved: policy is not being exercised");
        assertEq(handler.ghostCrossOwnerEdits(), 0, "an owner edited another owner's policy");
    }
}
