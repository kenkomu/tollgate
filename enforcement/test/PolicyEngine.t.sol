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

    function setUp() public {
        usdc = new MockUSDC();
        engine = new PolicyEngine(IERC20(address(usdc)));

        usdc.mint(owner, 10_000e6);

        vm.startPrank(owner);
        engine.createPolicy(agent, BUDGET, PER_TX, BUCKET, REFILL, 0);
        engine.setPayee(payee, true);
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
        assertEq(engine.getPolicy(owner).spent, 50e6, "spend recorded");
    }

    function test_spend_emitsSpent() public {
        vm.expectEmit(true, true, true, true);
        emit PolicyEngine.Spent(owner, agent, payee, 50e6, 50e6, BUCKET - 50e6);
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
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.NO_POLICY));
        engine.spend(payee, 1e6);
    }

    function test_reason_paused() public {
        vm.prank(owner);
        engine.setPaused(true);
        _expectBlocked(PolicyEngine.Reason.PAUSED, payee, 1e6);
    }

    function test_reason_expired() public {
        vm.prank(owner);
        engine.setExpiry(uint64(block.timestamp + 1 hours));

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
        engine.setCaps(BUDGET, BUDGET);
        engine.setVelocity(type(uint128).max, type(uint128).max);
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
        engine.setCaps(BUDGET, BUDGET);
        engine.setVelocity(50e6, 0); // 50 burst, never refills
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
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.PAYEE_NOT_ALLOWED)
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
            abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.EXCEEDS_VELOCITY)
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
        engine.setPaused(true);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.PAUSED));
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
        engine.setAgent(newAgent);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.NO_POLICY));
        engine.spend(payee, 1e6);

        vm.prank(newAgent);
        engine.spend(payee, 1e6);
        assertEq(usdc.balanceOf(payee), 1e6);
    }

    /*//////////////////////////////////////////////////////////////
                             THE TOKEN BUCKET
    //////////////////////////////////////////////////////////////*/

    function test_bucket_startsFull() public view {
        assertEq(engine.availableNow(owner), BUCKET);
    }

    function test_bucket_refillsContinuously() public {
        vm.prank(agent);
        engine.spend(payee, 100e6);
        assertEq(engine.availableNow(owner), BUCKET - 100e6);

        vm.warp(block.timestamp + 12 hours);
        // ~half a day at 200/day ≈ 100 back, so ≈ full again.
        assertApproxEqAbs(engine.availableNow(owner), BUCKET, 1e6);
    }

    function test_bucket_neverExceedsCapacity() public {
        vm.warp(block.timestamp + 365 days);
        assertEq(engine.availableNow(owner), BUCKET, "refill is capped at capacity");
    }

    /// @notice The property a tumbling window does not have: no burst at a boundary.
    ///         Drain the bucket, wait one refill period, and you get one period's worth
    ///         back — not a whole fresh allowance on top of what you just spent.
    function test_bucket_noBoundaryBurst() public {
        vm.startPrank(owner);
        engine.setCaps(type(uint128).max, type(uint128).max);
        usdc.approve(address(engine), type(uint128).max);
        vm.stopPrank();

        vm.prank(agent);
        engine.spend(payee, BUCKET); // bucket now empty
        assertEq(engine.availableNow(owner), 0);

        vm.warp(block.timestamp + 1 minutes);
        // A tumbling window that just rolled over would allow the full cap here.
        assertLt(engine.availableNow(owner), 1e6, "a minute buys a minute's worth");
    }

    /// @notice Widening the bucket must not hand out headroom that was never earned.
    ///         An owner raising the limit gets a faster refill, not an instant refund —
    ///         otherwise repeatedly re-setting velocity would be an unbounded spend hole.
    function test_setVelocity_wideningDoesNotRetroactivelyFill() public {
        vm.startPrank(agent);
        engine.spend(payee, PER_TX); // drain the bucket within the per-tx cap
        engine.spend(payee, PER_TX);
        vm.stopPrank();
        assertEq(engine.availableNow(owner), 0);

        vm.prank(owner);
        engine.setVelocity(type(uint128).max, REFILL); // much larger capacity

        assertEq(engine.availableNow(owner), 0, "still empty: capacity is not a deposit");
    }

    function test_setVelocity_settlesAtOldRateFirst() public {
        vm.prank(agent);
        engine.spend(payee, 100e6); // available = 100

        vm.warp(block.timestamp + 12 hours); // ≈ 200 (capped)

        vm.prank(owner);
        engine.setVelocity(50e6, 0); // shrink capacity to 50

        assertEq(engine.availableNow(owner), 50e6, "settled then clamped to new capacity");
    }

    /*//////////////////////////////////////////////////////////////
                            OWNER GUARDRAILS
    //////////////////////////////////////////////////////////////*/

    function test_setCaps_cannotDropBudgetBelowSpent() public {
        vm.prank(agent);
        engine.spend(payee, 100e6);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.BudgetBelowSpent.selector, uint128(50e6), uint128(100e6)));
        engine.setCaps(50e6, PER_TX);
    }

    function test_createPolicy_rejectsDuplicate() public {
        vm.prank(owner);
        vm.expectRevert(PolicyEngine.PolicyExists.selector);
        engine.createPolicy(makeAddr("other"), BUDGET, PER_TX, BUCKET, REFILL, 0);
    }

    function test_createPolicy_rejectsAgentBoundElsewhere() public {
        address other = makeAddr("otherOwner");
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.AgentAlreadyBound.selector, agent, owner));
        engine.createPolicy(agent, BUDGET, PER_TX, BUCKET, REFILL, 0);
    }

    function test_revokePolicy_unbindsAgent() public {
        vm.prank(owner);
        engine.revokePolicy();

        assertEq(engine.ownerOf(agent), address(0));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, PolicyEngine.Reason.NO_POLICY));
        engine.spend(payee, 1e6);
    }

    function test_onlyOwnerTouchesTheirOwnPolicy() public {
        // Everything is keyed on msg.sender, so a stranger simply has no policy.
        vm.prank(stranger);
        vm.expectRevert(PolicyEngine.NoPolicy.selector);
        engine.setPaused(true);

        assertFalse(engine.getPolicy(owner).paused, "owner's policy untouched");
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_spendNeverExceedsBudget(uint128 a, uint128 b, uint128 c) public {
        vm.startPrank(owner);
        engine.setVelocity(type(uint128).max, type(uint128).max);
        engine.setCaps(BUDGET, BUDGET);
        usdc.approve(address(engine), type(uint128).max);
        vm.stopPrank();

        _trySpend(a);
        _trySpend(b);
        _trySpend(c);

        assertLe(engine.getPolicy(owner).spent, BUDGET, "spent never exceeds budgetCap");
    }

    function testFuzz_blockedSpendMovesNothing(uint256 amount, address to) public {
        vm.assume(to != address(0) && to != owner);
        uint256 balBefore = usdc.balanceOf(owner);
        uint128 spentBefore = engine.getPolicy(owner).spent;

        vm.prank(agent);
        try engine.spend(to, amount) {}
        catch {
            assertEq(usdc.balanceOf(owner), balBefore, "a refused spend moves no money");
            assertEq(engine.getPolicy(owner).spent, spentBefore, "and records nothing");
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _expectBlocked(PolicyEngine.Reason reason, address to, uint256 amount) internal {
        assertEq(uint256(engine.checkTransfer(agent, to, amount)), uint256(reason), "checkTransfer reason");
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyEngine.PolicyViolation.selector, reason));
        engine.spend(to, amount);
    }

    function _trySpend(uint128 amount) internal {
        vm.prank(agent);
        try engine.spend(payee, amount) {} catch {}
    }
}
