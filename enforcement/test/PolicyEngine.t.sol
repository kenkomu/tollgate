// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PolicyEngine} from "../src/PolicyEngine.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Unit coverage for PolicyEngine: every reason code, and the boundaries either
///         side of every cap. §3.2 of the plan asks for exactly this before anything else.
contract PolicyEngineTest is Test {
    PolicyEngine engine;
    MockUSDC usdc;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address payee = makeAddr("payee");
    address stranger = makeAddr("stranger");

    uint128 constant BUDGET = 1_000e6; // 1,000 USDC lifetime
    uint128 constant PER_TX = 100e6; // 100 USDC per transfer
    uint128 constant BUCKET = 200e6; // 200 USDC burst
    uint128 constant REFILL = 200e6 / uint128(1 days); // ~200 USDC/day

    uint256 id; // the owner's first policy

    function setUp() public {
        usdc = new MockUSDC();
        engine = new PolicyEngine(IERC20(address(usdc)));

        usdc.mint(owner, 10_000e6);

        vm.startPrank(owner);
        id = engine.createPolicy(agent, BUDGET, PER_TX, BUCKET, REFILL, 0);
        engine.setPayee(id, payee, true);
        usdc.approve(address(engine), BUDGET); // exactly the budget — never max
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              THE HAPPY PATH
    //////////////////////////////////////////////////////////////*/

    function test_spend_movesFundsOwnerToPayee() public {
        vm.prank(agent);
        engine.spend(payee, 50e6);

        assertEq(usdc.balanceOf(payee), 50e6, "payee received");
        assertEq(usdc.balanceOf(owner), 10_000e6 - 50e6, "owner debited");
        assertEq(usdc.balanceOf(address(engine)), 0, "engine holds nothing, ever");
        assertEq(engine.getPolicy(id).spent, 50e6, "spend recorded");
    }

    function test_spend_emitsSpent() public {
        vm.expectEmit(true, true, true, true);
        emit PolicyEngine.Spent(owner, agent, payee, id, 50e6, 50e6, BUCKET - 50e6);
        vm.prank(agent);
        engine.spend(payee, 50e6);
    }

    function test_checkTransfer_agreesWithSpend() public view {
        assertEq(uint256(engine.checkTransfer(agent, payee, 50e6)), uint256(PolicyEngine.Reason.OK));
    }

    /*//////////////////////////////////////////////////////////////
                          EVERY REASON CODE
    //////////////////////////////////////////////////////////////*/

    function test_reason_noPolicy() public {
        assertEq(uint256(engine.checkTransfer(stranger, payee, 1e6)), uint256(PolicyEngine.Reason.NO_POLICY));
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.NO_POLICY)
        );
        engine.spend(payee, 1e6);
    }

    function test_reason_paused() public {
        vm.prank(owner);
        engine.setPaused(id, true);
        _expectBlocked(PolicyEngine.Reason.PAUSED, payee, 1e6);
    }

    function test_reason_expired() public {
        vm.prank(owner);
        engine.setExpiry(id, uint64(block.timestamp + 1 hours));

        vm.warp(block.timestamp + 2 hours);
        _expectBlocked(PolicyEngine.Reason.EXPIRED, payee, 1e6);
    }

    function test_reason_amountZero() public {
        _expectBlocked(PolicyEngine.Reason.AMOUNT_ZERO, payee, 0);
    }

    function test_reason_payeeNotAllowed() public {
        _expectBlocked(PolicyEngine.Reason.PAYEE_NOT_ALLOWED, stranger, 1e6);
    }

    function test_reason_exceedsPerTx() public {
        _expectBlocked(PolicyEngine.Reason.EXCEEDS_PER_TX, payee, PER_TX + 1);
    }

    function test_reason_exceedsBudget() public {
        // Raise per-tx and velocity out of the way so budget is the binding constraint.
        // Note: widening capacity does not retroactively fill the bucket — headroom has
        // to be earned by elapsed time — so warp a second to let the new rate fill it.
        vm.startPrank(owner);
        engine.setCaps(id, BUDGET, BUDGET);
        engine.setVelocity(id, type(uint128).max, type(uint128).max);
        usdc.approve(address(engine), type(uint128).max);
        vm.stopPrank();
        vm.warp(block.timestamp + 1);

        vm.prank(agent);
        engine.spend(payee, BUDGET); // exactly the budget is fine

        _expectBlocked(PolicyEngine.Reason.EXCEEDS_BUDGET, payee, 1);
    }

    function test_reason_exceedsVelocity() public {
        // Budget has room; the bucket does not.
        vm.startPrank(owner);
        engine.setCaps(id, BUDGET, BUDGET);
        engine.setVelocity(id, 50e6, 0); // 50 burst, never refills
        vm.stopPrank();

        vm.prank(agent);
        engine.spend(payee, 50e6);

        _expectBlocked(PolicyEngine.Reason.EXCEEDS_VELOCITY, payee, 1);
    }

    function test_reason_insufficientAllowance() public {
        vm.prank(owner);
        usdc.approve(address(engine), 10e6);
        _expectBlocked(PolicyEngine.Reason.INSUFFICIENT_ALLOWANCE, payee, 20e6);
    }

    function test_reason_insufficientBalance() public {
        uint256 balance = usdc.balanceOf(owner); // read first: a call would eat the prank
        vm.prank(owner);
        usdc.transfer(stranger, balance);
        _expectBlocked(PolicyEngine.Reason.INSUFFICIENT_BALANCE, payee, 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                        THE COMPROMISED-AGENT STORY
    //////////////////////////////////////////////////////////////*/

    /// @notice The demo. Assume the agent key is fully in an attacker's hands.
    ///         Policy still holds, because it was never enforced by the agent.
    function test_compromisedAgent_cannotEscapePolicy() public {
        // The attacker has the key and does whatever they like with it.
        vm.startPrank(agent);

        // ...pay themselves? Not on the allowlist.
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.PAYEE_NOT_ALLOWED
            )
        );
        engine.spend(stranger, 1e6);

        // ...drain it in one go? Over the per-transaction cap.
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.EXCEEDS_PER_TX)
        );
        engine.spend(payee, BUDGET);

        // ...grind it out under the cap? The bucket runs dry.
        engine.spend(payee, PER_TX);
        engine.spend(payee, PER_TX);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.EXCEEDS_VELOCITY
            )
        );
        engine.spend(payee, PER_TX);
        vm.stopPrank();

        // Total damage is bounded by the burst, not the wallet.
        assertEq(usdc.balanceOf(payee), 2 * uint256(PER_TX));
        assertEq(usdc.balanceOf(owner), 10_000e6 - 2 * uint256(PER_TX));
    }

    /// @notice The owner's response, and it does not need our backend to work.
    function test_killSwitch_stopsEverythingImmediately() public {
        vm.prank(owner);
        engine.setPaused(id, true);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.PAUSED)
        );
        engine.spend(payee, 1e6);
    }

    /// @notice The owner can always leave. This contract cannot stop them.
    function test_ownerExitsByRevokingAllowance() public {
        vm.prank(owner);
        usdc.approve(address(engine), 0);

        _expectBlocked(PolicyEngine.Reason.INSUFFICIENT_ALLOWANCE, payee, 1e6);
    }

    function test_rotatingAgentStrandsTheOldKey() public {
        address newAgent = makeAddr("newAgent");
        vm.prank(owner);
        engine.setAgent(id, newAgent);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.NO_POLICY)
        );
        engine.spend(payee, 1e6);

        vm.prank(newAgent);
        engine.spend(payee, 1e6);
        assertEq(usdc.balanceOf(payee), 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                             THE TOKEN BUCKET
    //////////////////////////////////////////////////////////////*/

    function test_bucket_startsFull() public view {
        assertEq(engine.availableNow(id), BUCKET);
    }

    function test_bucket_refillsContinuously() public {
        vm.prank(agent);
        engine.spend(payee, 100e6);
        assertEq(engine.availableNow(id), BUCKET - 100e6);

        vm.warp(block.timestamp + 12 hours);
        // ~half a day at 200/day ≈ 100 back, so ≈ full again.
        assertApproxEqAbs(engine.availableNow(id), BUCKET, 1e6);
    }

    function test_bucket_neverExceedsCapacity() public {
        vm.warp(block.timestamp + 365 days);
        assertEq(engine.availableNow(id), BUCKET, "refill is capped at capacity");
    }

    /// @notice The property a tumbling window does not have: no burst at a boundary.
    ///         Drain the bucket, wait one refill period, and you get one period's worth
    ///         back — not a whole fresh allowance on top of what you just spent.
    function test_bucket_noBoundaryBurst() public {
        vm.startPrank(owner);
        engine.setCaps(id, type(uint128).max, type(uint128).max);
        usdc.approve(address(engine), type(uint128).max);
        vm.stopPrank();

        vm.prank(agent);
        engine.spend(payee, BUCKET); // bucket now empty
        assertEq(engine.availableNow(id), 0);

        vm.warp(block.timestamp + 1 minutes);
        // A tumbling window that just rolled over would allow the full cap here.
        assertLt(engine.availableNow(id), 1e6, "a minute buys a minute's worth");
    }

    /// @notice Widening the bucket must not hand out headroom that was never earned.
    ///         An owner raising the limit gets a faster refill, not an instant refund —
    ///         otherwise repeatedly re-setting velocity would be an unbounded spend hole.
    function test_setVelocity_wideningDoesNotRetroactivelyFill() public {
        vm.startPrank(agent);
        engine.spend(payee, PER_TX); // drain the bucket within the per-tx cap
        engine.spend(payee, PER_TX);
        vm.stopPrank();
        assertEq(engine.availableNow(id), 0);

        vm.prank(owner);
        engine.setVelocity(id, type(uint128).max, REFILL); // much larger capacity

        assertEq(engine.availableNow(id), 0, "still empty: capacity is not a deposit");
    }

    function test_setVelocity_settlesAtOldRateFirst() public {
        vm.prank(agent);
        engine.spend(payee, 100e6); // available = 100

        vm.warp(block.timestamp + 12 hours); // ≈ 200 (capped)

        vm.prank(owner);
        engine.setVelocity(id, 50e6, 0); // shrink capacity to 50

        assertEq(engine.availableNow(id), 50e6, "settled then clamped to new capacity");
    }

    /*//////////////////////////////////////////////////////////////
                            OWNER GUARDRAILS
    //////////////////////////////////////////////////////////////*/

    function test_setCaps_cannotDropBudgetBelowSpent() public {
        vm.prank(agent);
        engine.spend(payee, 100e6);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEngine.BudgetBelowSpent.selector, uint128(50e6), uint128(100e6))
        );
        engine.setCaps(id, 50e6, PER_TX);
    }

    function test_createPolicy_secondAgentGetsItsOwnPolicy() public {
        vm.prank(owner);
        uint256 second = engine.createPolicy(makeAddr("other"), BUDGET, PER_TX, BUCKET, REFILL, 0);
        assertEq(second, id + 1, "ids are sequential");
        assertEq(engine.policiesOf(owner).length, 2);
    }

    function test_createPolicy_rejectsAgentBoundElsewhere() public {
        address other = makeAddr("otherOwner");
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.AgentAlreadyBound.selector, agent, id));
        engine.createPolicy(agent, BUDGET, PER_TX, BUCKET, REFILL, 0);
    }

    function test_revokePolicy_unbindsAgent() public {
        vm.prank(owner);
        engine.revokePolicy(id);

        assertEq(engine.ownerOf(agent), address(0));
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.NO_POLICY)
        );
        engine.spend(payee, 1e6);
    }

    function test_onlyOwnerTouchesTheirOwnPolicy() public {
        // Policy ids are public. Knowing one gives a stranger nothing.
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotPolicyOwner.selector, id));
        engine.setPaused(id, true);

        assertFalse(engine.getPolicy(id).paused, "owner's policy untouched");
    }

    /*//////////////////////////////////////////////////////////////
                          MANY AGENTS, ONE OWNER
    //////////////////////////////////////////////////////////////*/

    /// A second agent with its own policy, payee and budget, on the same owner wallet.
    function _secondAgent() internal returns (address agent2, uint256 id2, address payee2) {
        agent2 = makeAddr("agent2");
        payee2 = makeAddr("payee2");
        vm.startPrank(owner);
        id2 = engine.createPolicy(agent2, 50e6, 10e6, 20e6, 0, 0);
        engine.setPayee(id2, payee2, true);
        usdc.approve(address(engine), BUDGET + 50e6); // the sum of both budgets
        vm.stopPrank();
    }

    /// The point of per-agent allowlists: a leaked key reaches its own payees, never another's.
    function test_multi_allowlistsDoNotLeakBetweenAgents() public {
        (address agent2,, address payee2) = _secondAgent();

        assertEq(
            uint256(engine.checkTransfer(agent2, payee, 1e6)), uint256(PolicyEngine.Reason.PAYEE_NOT_ALLOWED)
        );
        assertEq(
            uint256(engine.checkTransfer(agent, payee2, 1e6)), uint256(PolicyEngine.Reason.PAYEE_NOT_ALLOWED)
        );
        assertEq(uint256(engine.checkTransfer(agent2, payee2, 1e6)), uint256(PolicyEngine.Reason.OK));
    }

    function test_multi_budgetsAreSeparate() public {
        (address agent2, uint256 id2, address payee2) = _secondAgent();

        vm.prank(agent2);
        engine.spend(payee2, 10e6);

        assertEq(engine.getPolicy(id2).spent, 10e6);
        assertEq(engine.getPolicy(id).spent, 0, "the other agent's budget is untouched");
        // agent2 caps at 10 per payment even though agent's policy allows 100.
        vm.prank(agent2);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.EXCEEDS_PER_TX)
        );
        engine.spend(payee2, 11e6);
    }

    function test_multi_pausingOneLeavesTheOtherRunning() public {
        (address agent2,, address payee2) = _secondAgent();
        vm.prank(owner);
        engine.setPaused(id, true);

        _expectBlocked(PolicyEngine.Reason.PAUSED, payee, 1e6);
        vm.prank(agent2);
        engine.spend(payee2, 1e6);
    }

    /// One transaction stops the whole fleet.
    function test_multi_ownerPauseStopsEveryAgent() public {
        (address agent2,, address payee2) = _secondAgent();
        vm.expectEmit(true, true, true, true);
        emit PolicyEngine.OwnerPauseSet(owner, true);
        vm.prank(owner);
        engine.setOwnerPaused(true);

        _expectBlocked(PolicyEngine.Reason.PAUSED, payee, 1e6);
        assertEq(uint256(engine.checkTransfer(agent2, payee2, 1e6)), uint256(PolicyEngine.Reason.PAUSED));

        vm.prank(owner);
        engine.setOwnerPaused(false);
        vm.prank(agent2);
        engine.spend(payee2, 1e6);
    }

    /// Resuming the fleet must not quietly un-pause an agent the owner stopped on its own.
    function test_multi_ownerResumeKeepsIndividualPauses() public {
        vm.startPrank(owner);
        engine.setPaused(id, true);
        engine.setOwnerPaused(true);
        engine.setOwnerPaused(false);
        vm.stopPrank();

        _expectBlocked(PolicyEngine.Reason.PAUSED, payee, 1e6);
    }

    /// Another owner's fleet switch has no effect on this owner.
    function test_multi_ownerPauseIsPerOwner() public {
        vm.prank(stranger);
        engine.setOwnerPaused(true);
        assertEq(uint256(engine.checkTransfer(agent, payee, 1e6)), uint256(PolicyEngine.Reason.OK));
    }

    function test_multi_oneKeyCannotServeTwoPolicies() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.AgentAlreadyBound.selector, agent, id));
        engine.createPolicy(agent, BUDGET, PER_TX, BUCKET, REFILL, 0);

        (address agent2, uint256 id2,) = _secondAgent();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.AgentAlreadyBound.selector, agent2, id2));
        engine.setAgent(id, agent2);
    }

    function test_multi_rotationKeepsTheAllowlist() public {
        address fresh = makeAddr("fresh");
        vm.prank(owner);
        engine.setAgent(id, fresh);

        assertTrue(engine.isAllowedPayee(id, payee), "payees belong to the policy, not the key");
        vm.prank(fresh);
        engine.spend(payee, 1e6);
        assertEq(engine.ownerOf(fresh), owner);
        assertEq(engine.ownerOf(agent), address(0));
    }

    function test_multi_revokeRemovesOnlyThatPolicy() public {
        (address agent2, uint256 id2,) = _secondAgent();
        address agent3 = makeAddr("agent3");
        vm.prank(owner);
        uint256 id3 = engine.createPolicy(agent3, 1e6, 1e6, 1e6, 0, 0);

        vm.prank(owner);
        engine.revokePolicy(id); // the first of three: exercises the swap-and-pop

        uint256[] memory left = engine.policiesOf(owner);
        assertEq(left.length, 2);
        assertTrue((left[0] == id2 && left[1] == id3) || (left[0] == id3 && left[1] == id2));
        assertEq(engine.policyOf(agent), 0);
        assertEq(engine.policyOf(agent2), id2);

        // And the remaining ones can still be revoked cleanly.
        vm.startPrank(owner);
        engine.revokePolicy(id3);
        engine.revokePolicy(id2);
        vm.stopPrank();
        assertEq(engine.policiesOf(owner).length, 0);
    }

    function test_multi_revokedIdIsDeadForever() public {
        vm.startPrank(owner);
        engine.revokePolicy(id);
        vm.expectRevert(PolicyEngine.NoPolicy.selector);
        engine.setPaused(id, true);
        vm.expectRevert(PolicyEngine.NoPolicy.selector);
        engine.revokePolicy(id);
        // A new policy gets a new id, and does not inherit the old allowlist.
        uint256 next = engine.createPolicy(agent, BUDGET, PER_TX, BUCKET, REFILL, 0);
        vm.stopPrank();
        assertGt(next, id);
        assertFalse(engine.isAllowedPayee(next, payee));
    }

    function test_multi_ownerCannotEditAnotherOwnersPolicy() public {
        address other = makeAddr("otherOwner");
        address otherAgent = makeAddr("otherAgent");
        vm.prank(other);
        uint256 theirs = engine.createPolicy(otherAgent, 1e6, 1e6, 1e6, 0, 0);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotPolicyOwner.selector, theirs));
        engine.setCaps(theirs, type(uint128).max, type(uint128).max);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotPolicyOwner.selector, theirs));
        engine.setPayee(theirs, stranger, true);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotPolicyOwner.selector, theirs));
        engine.setAgent(theirs, stranger);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.NotPolicyOwner.selector, theirs));
        engine.revokePolicy(theirs);
        vm.stopPrank();
    }

    /// The allowance is the ceiling across all agents together, whatever their budgets say.
    function test_multi_sharedAllowanceBindsAcrossAgents() public {
        (address agent2,, address payee2) = _secondAgent();
        vm.prank(owner);
        usdc.approve(address(engine), 15e6);

        vm.prank(agent);
        engine.spend(payee, 10e6);
        vm.prank(agent2);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.INSUFFICIENT_ALLOWANCE
            )
        );
        engine.spend(payee2, 10e6);
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_spendNeverExceedsBudget(
        uint128 a,
        uint128 b,
        uint128 c
    ) public {
        vm.startPrank(owner);
        engine.setVelocity(id, type(uint128).max, type(uint128).max);
        engine.setCaps(id, BUDGET, BUDGET);
        usdc.approve(address(engine), type(uint128).max);
        vm.stopPrank();

        _trySpend(a);
        _trySpend(b);
        _trySpend(c);

        assertLe(engine.getPolicy(id).spent, BUDGET, "spent never exceeds budgetCap");
    }

    function testFuzz_blockedSpendMovesNothing(
        uint256 amount,
        address to
    ) public {
        vm.assume(to != address(0) && to != owner);
        uint256 balBefore = usdc.balanceOf(owner);
        uint128 spentBefore = engine.getPolicy(id).spent;

        vm.prank(agent);
        try engine.spend(to, amount) {}
        catch {
            assertEq(usdc.balanceOf(owner), balBefore, "a refused spend moves no money");
            assertEq(engine.getPolicy(id).spent, spentBefore, "and records nothing");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    /*//////////////////////////////////////////////////////////////
                        trySpend — REFUSALS ON RECORD
    //////////////////////////////////////////////////////////////*/

    /// A reverted `spend` discards its own logs, so an owner reading the chain could see
    /// every payment their agent made and nothing it was stopped from making. These lock
    /// in the other half of that record.

    function test_trySpend_emitsRefusedAndMovesNothing() public {
        uint256 ownerBefore = usdc.balanceOf(owner);

        vm.expectEmit(true, true, true, true);
        emit PolicyEngine.Refused(owner, agent, stranger, id, 10e6, PolicyEngine.Reason.PAYEE_NOT_ALLOWED);

        vm.prank(agent);
        PolicyEngine.Reason r = engine.trySpend(stranger, 10e6);

        assertEq(uint256(r), uint256(PolicyEngine.Reason.PAYEE_NOT_ALLOWED), "reason returned, not reverted");
        assertEq(usdc.balanceOf(stranger), 0, "payee got nothing");
        assertEq(usdc.balanceOf(owner), ownerBefore, "owner untouched");
        assertEq(engine.getPolicy(id).spent, 0, "refusal is not a spend");
    }

    function test_trySpend_succeedsExactlyLikeSpend() public {
        vm.prank(agent);
        PolicyEngine.Reason r = engine.trySpend(payee, 50e6);

        assertEq(uint256(r), uint256(PolicyEngine.Reason.OK));
        assertEq(usdc.balanceOf(payee), 50e6, "funds moved");
        assertEq(engine.getPolicy(id).spent, 50e6, "spend recorded");
        assertEq(usdc.balanceOf(address(engine)), 0, "engine still holds nothing");
    }

    /// The two entry points share `_attempt`, so this is the test that keeps them honest.
    function test_trySpend_reasonMatchesSpendRevert() public {
        PolicyEngine.Reason predicted = engine.checkTransfer(agent, stranger, 10e6);

        vm.prank(agent);
        PolicyEngine.Reason returned = engine.trySpend(stranger, 10e6);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, predicted));
        engine.spend(stranger, 10e6);

        assertEq(uint256(returned), uint256(predicted), "trySpend agrees with checkTransfer and spend");
    }

    function test_trySpend_unboundAgentIsRefusedNotReverted() public {
        vm.prank(stranger);
        PolicyEngine.Reason r = engine.trySpend(payee, 1e6);
        assertEq(uint256(r), uint256(PolicyEngine.Reason.NO_POLICY));
    }

    /// A refused attempt must not quietly consume velocity headroom or budget.
    function test_trySpend_refusalConsumesNothing() public {
        uint128 availableBefore = engine.availableNow(id);

        vm.prank(agent);
        engine.trySpend(stranger, 10e6);

        assertEq(engine.availableNow(id), availableBefore, "bucket untouched");
        assertEq(engine.remainingBudget(id), BUDGET, "budget untouched");
    }

    /*//////////////////////////////////////////////////////////////
                            PAYEE GUARDRAILS
    //////////////////////////////////////////////////////////////*/

    /// The engine can never send what it receives, so paying it destroys the money.
    function test_setPayee_rejectsTheEngineItself() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.InvalidPayee.selector, address(engine)));
        engine.setPayee(id, address(engine), true);

        assertFalse(engine.isAllowedPayee(id, address(engine)), "never allowlisted");
    }

    function test_setPayee_stillRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(PolicyEngine.ZeroAddress.selector);
        engine.setPayee(id, address(0), true);
    }

    function _expectBlocked(
        PolicyEngine.Reason reason,
        address to,
        uint256 amount
    ) internal {
        assertEq(uint256(engine.checkTransfer(agent, to, amount)), uint256(reason), "checkTransfer reason");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, reason));
        engine.spend(to, amount);
    }

    function _trySpend(
        uint128 amount
    ) internal {
        vm.prank(agent);
        try engine.spend(payee, amount) {} catch {}
    }
}
