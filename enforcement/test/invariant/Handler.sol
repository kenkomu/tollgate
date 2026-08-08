// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PolicyEngine} from "../../src/PolicyEngine.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives PolicyEngine through random sequences of owner and agent actions.
///         Owners fight the agents; time moves; caps change underneath live policies.
///         The invariants in PolicyEngineInvariants must survive all of it.
contract Handler is CommonBase, StdCheats, StdUtils {
    PolicyEngine public immutable engine;
    MockUSDC public immutable usdc;

    address[3] public owners;
    address[3] public agents;
    address[2] public payees;

    /// @dev Ghost accounting: what we believe moved, tracked independently of the contract.
    uint256 public ghostTotalSpent;
    uint256 public ghostSuccessfulSpends;
    uint256 public ghostBlockedSpends;

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
        agents = [makeAddr("agent0"), makeAddr("agent1"), makeAddr("agent2")];
        payees = [makeAddr("payee0"), makeAddr("payee1")];

        for (uint256 i; i < owners.length; ++i) {
            usdc.mint(owners[i], 1_000_000e6);
            vm.startPrank(owners[i]);
            engine.createPolicy(agents[i], 100_000e6, 10_000e6, 20_000e6, 1e6, 0);
            engine.setPayee(payees[0], true);
            engine.setPayee(payees[1], true);
            usdc.approve(address(engine), 100_000e6);
            vm.stopPrank();
        }
    }

    function _owner(
        uint256 seed
    ) internal view returns (address) {
        return owners[seed % owners.length];
    }

    function _agent(
        uint256 seed
    ) internal view returns (address) {
        return agents[seed % agents.length];
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
        address agent = _agent(agentSeed);
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
        uint256 ownerSeed,
        uint256 seed
    ) external {
        vm.prank(_owner(ownerSeed));
        try engine.setPaused(seed % 5 == 0) {} catch {}
    }

    function setCaps(
        uint256 ownerSeed,
        uint128 budgetCap,
        uint128 perTxCap
    ) external {
        budgetCap = uint128(bound(budgetCap, 50_000e6, 500_000e6));
        perTxCap = uint128(bound(perTxCap, 1_000e6, 50_000e6));
        vm.prank(_owner(ownerSeed));
        try engine.setCaps(budgetCap, perTxCap) {} catch {}
    }

    function setVelocity(
        uint256 ownerSeed,
        uint128 capacity,
        uint128 refill
    ) external {
        capacity = uint128(bound(capacity, 5_000e6, 500_000e6));
        refill = uint128(bound(refill, 0, 1_000e6));
        vm.prank(_owner(ownerSeed));
        try engine.setVelocity(capacity, refill) {} catch {}
    }

    /// @dev Biased toward allowed, for the same reason `setPaused` is biased toward
    ///      running: an allowlist that is empty most of the time starves the happy path.
    function setPayee(
        uint256 ownerSeed,
        uint256 payeeSeed,
        uint256 seed
    ) external {
        vm.prank(_owner(ownerSeed));
        try engine.setPayee(_payee(payeeSeed), seed % 4 != 0) {} catch {}
    }

    /// @dev Mostly "never expires". Random near-future expiries plus 30-day warps
    ///      otherwise strand every policy permanently past its deadline.
    function setExpiry(
        uint256 ownerSeed,
        uint64 expiry
    ) external {
        uint64 value =
            expiry % 3 == 0 ? uint64(bound(expiry, block.timestamp, block.timestamp + 365 days)) : 0;
        vm.prank(_owner(ownerSeed));
        try engine.setExpiry(value) {} catch {}
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

    /*//////////////////////////////////////////////////////////////
                                  TIME
    //////////////////////////////////////////////////////////////*/

    function warp(
        uint256 secs
    ) external {
        vm.warp(block.timestamp + bound(secs, 1, 30 days));
    }
}
