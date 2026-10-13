// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title PolicyEngine
/// @notice On-chain spend policy for autonomous agents. Non-custodial: this contract
///         never holds funds. The owner grants an ERC-20 allowance and this contract
///         pulls owner -> payee only when policy permits.
///
/// @dev    Design notes that matter for review:
///
///         1. NO CUSTODY. There is no deposit function and no withdraw function.
///            The contract's own USDC balance is never read and should always be zero.
///            An owner revokes by calling `approve(policyEngine, 0)` on USDC directly —
///            they do not need this contract, its operator, or any server to cooperate.
///
///         2. THE ALLOWANCE IS A SECOND CEILING. Owners are expected to approve exactly
///            the sum of their budgets, never type(uint256).max. If this contract is wrong,
///            the blast radius is the outstanding allowance rather than the whole wallet.
///            With several agents it is also the ceiling across all of them together.
///
///         3. ONE SOURCE OF POLICY TRUTH. `checkTransfer` (a view, used by the SDK for
///            pre-flight) and `spend` (enforcement) both delegate to `_evaluate`. They
///            cannot drift, because there is only one implementation.
///
///         4. DECIMALS. On Arc, native USDC is 18 decimals for gas accounting while the
///            ERC-20 interface is 6. Every amount in this contract is 6-decimal ERC-20
///            units. This contract never reads a native balance.
///
///         5. MANY AGENTS, ONE LEASH EACH (docs/decisions/0010). An owner may run any number
///            of agents. Each has its own policy, numbered by `policyId`, with its own caps,
///            rate limit, expiry, pause and payee allowlist. Nothing is shared between an
///            owner's agents except the owner-wide pause and the one USDC allowance, so a
///            leaked key reaches exactly one policy's budget and one policy's payees.
contract PolicyEngine is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Why a spend was allowed or refused. Surfaced by the SDK and rendered
    ///         in plain English in the audit log. Order is part of the ABI — append only.
    enum Reason {
        OK, //                     0  permitted
        NO_POLICY, //              1  no policy exists for this agent
        NOT_AGENT, //              2  caller is not the registered agent
        PAUSED, //                 3  owner hit the kill switch (this policy, or all of them)
        EXPIRED, //                4  session key past its expiry
        PAYEE_NOT_ALLOWED, //      5  payee is not on this policy's allowlist
        AMOUNT_ZERO, //            6  nothing to send
        EXCEEDS_PER_TX, //         7  single transfer above the per-transaction cap
        EXCEEDS_BUDGET, //         8  would push lifetime spend past the budget cap
        EXCEEDS_VELOCITY, //       9  spending faster than the refill rate allows
        INSUFFICIENT_ALLOWANCE, // 10 owner has not approved enough
        INSUFFICIENT_BALANCE //    11 owner cannot cover it
    }

    struct Policy {
        // ---- slot 0 ----
        address agent; //           the session key permitted to spend
        uint64 expiry; //           unix seconds; 0 means never expires
        bool paused; //             this policy's kill switch
        bool exists;
        // ---- slot 1 ----
        uint128 budgetCap; //       lifetime ceiling
        uint128 spent; //           lifetime total, monotonically non-decreasing
        // ---- slot 2 ----
        uint128 perTxCap; //        ceiling on any single transfer
        uint128 bucketCapacity; //  velocity: burst ceiling
        // ---- slot 3 ----
        uint128 refillPerSecond; // velocity: sustained rate
        uint128 available; //       velocity: tokens in the bucket at lastRefill
        // ---- slot 4 ----
        uint64 lastRefill;
        address owner; //           whose wallet this policy spends from
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The USDC ERC-20 interface. On Arc this is the predeploy at
    ///         0x3600000000000000000000000000000000000000 (6 decimals).
    IERC20 public immutable USDC;

    /// @notice How many policies have ever been created. Ids start at 1, so 0 means "none".
    uint256 public policyCount;

    mapping(uint256 policyId => Policy) private _policies;

    /// @notice Reverse index so an agent can call `spend` without naming its policy.
    ///         One key, one policy: a key can never serve two policies, of any owner.
    mapping(address agent => uint256 policyId) public policyOf;

    /// @notice Strict allowlist, per policy. An agent may only pay addresses the owner named
    ///         for that agent. Keyed by policy rather than agent so rotating a key keeps it.
    mapping(uint256 policyId => mapping(address payee => bool)) public isAllowedPayee;

    /// @notice The owner-wide kill switch: while set, every one of this owner's agents is
    ///         refused, whatever its own policy says. One transaction stops a whole fleet.
    mapping(address owner => bool) public ownerPaused;

    /// @dev An owner's live policies, for enumeration, with each id's position (plus one) so
    ///      revoking is O(1) by swap-and-pop.
    mapping(address owner => uint256[]) private _policiesOf;
    mapping(uint256 policyId => uint256) private _positionPlusOne;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event PolicyCreated(
        address indexed owner,
        uint256 indexed policyId,
        address indexed agent,
        uint128 budgetCap,
        uint128 perTxCap,
        uint128 bucketCapacity,
        uint128 refillPerSecond,
        uint64 expiry
    );
    event CapsUpdated(address indexed owner, uint256 indexed policyId, uint128 budgetCap, uint128 perTxCap);
    event VelocityUpdated(
        address indexed owner, uint256 indexed policyId, uint128 bucketCapacity, uint128 refillPerSecond
    );
    /// @dev Every event carries the owner as a topic, so one owner's history is one log filter.
    event AgentRotated(
        address indexed owner, uint256 indexed policyId, address indexed newAgent, address previousAgent
    );
    event ExpiryUpdated(address indexed owner, uint256 indexed policyId, uint64 expiry);
    event PayeeSet(address indexed owner, uint256 indexed policyId, address indexed payee, bool allowed);
    event PauseSet(address indexed owner, uint256 indexed policyId, bool paused);
    event OwnerPauseSet(address indexed owner, bool paused);
    event PolicyRevoked(address indexed owner, uint256 indexed policyId, address indexed agent);
    event Spent(
        address indexed owner,
        address indexed agent,
        address indexed payee,
        uint256 policyId,
        uint256 amount,
        uint128 spentTotal,
        uint128 availableAfter
    );

    /// @notice An attempt that policy refused, recorded on chain.
    /// @dev    A reverted `spend` leaves no trace — the revert discards the log with
    ///         everything else — so an owner could see what their agent was ALLOWED to do
    ///         and never what it was STOPPED from doing. That is the wrong half of the
    ///         story for a product whose entire claim is that it stops things. `trySpend`
    ///         exists to emit this: the attempt costs gas, commits no funds, and leaves a
    ///         permanent record that the agent asked and was told no.
    event Refused(
        address indexed owner,
        address indexed agent,
        address indexed payee,
        uint256 policyId,
        uint256 amount,
        Reason reason
    );

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A spend was refused. `reason` is the machine-readable code the SDK renders.
    error PolicyViolation(Reason reason);
    error NoPolicy();
    /// @notice The caller does not own this policy. Owners can only ever edit their own.
    error NotPolicyOwner(uint256 policyId);
    error AgentAlreadyBound(address agent, uint256 existingPolicyId);
    error ZeroAddress();
    error BudgetBelowSpent(uint128 requested, uint128 alreadySpent);
    /// @notice The payee cannot be allowlisted, because paying it would destroy the funds.
    error InvalidPayee(address payee);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        IERC20 usdc
    ) {
        if (address(usdc) == address(0)) revert ZeroAddress();
        USDC = usdc;
    }

    /// @dev Every owner function goes through this. A policy id is public and guessable, so
    ///      the check that the caller owns it is the whole of the access control.
    function _owned(
        uint256 policyId
    ) internal view returns (Policy storage p) {
        p = _policies[policyId];
        if (!p.exists) revert NoPolicy();
        if (p.owner != msg.sender) revert NotPolicyOwner(policyId);
    }

    /*//////////////////////////////////////////////////////////////
                            OWNER: LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a policy for one of this caller's agents and bind its session key.
    /// @param agent            the session key permitted to spend
    /// @param budgetCap        lifetime ceiling, 6-decimal USDC
    /// @param perTxCap         ceiling on any single transfer
    /// @param bucketCapacity   velocity burst ceiling — the most spendable at once when full
    /// @param refillPerSecond  velocity sustained rate
    /// @param expiry           unix seconds; 0 means never expires
    /// @return policyId        the new policy's id, which every owner function takes
    function createPolicy(
        address agent,
        uint128 budgetCap,
        uint128 perTxCap,
        uint128 bucketCapacity,
        uint128 refillPerSecond,
        uint64 expiry
    ) external returns (uint256 policyId) {
        if (agent == address(0)) revert ZeroAddress();
        uint256 boundTo = policyOf[agent];
        if (boundTo != 0) revert AgentAlreadyBound(agent, boundTo);

        policyId = ++policyCount;
        Policy storage p = _policies[policyId];
        p.exists = true;
        p.owner = msg.sender;
        p.agent = agent;
        p.budgetCap = budgetCap;
        p.perTxCap = perTxCap;
        p.bucketCapacity = bucketCapacity;
        p.refillPerSecond = refillPerSecond;
        p.expiry = expiry;
        // The bucket starts full: a fresh policy can spend up to its burst immediately.
        p.available = bucketCapacity;
        p.lastRefill = uint64(block.timestamp);

        policyOf[agent] = policyId;
        _policiesOf[msg.sender].push(policyId);
        _positionPlusOne[policyId] = _policiesOf[msg.sender].length;

        emit PolicyCreated(
            msg.sender, policyId, agent, budgetCap, perTxCap, bucketCapacity, refillPerSecond, expiry
        );
    }

    /// @notice Tear down one policy and unbind its agent. Does not touch funds — the owner
    ///         should also lower the USDC allowance by that policy's remaining budget.
    /// @dev    The allowlist entries are left in storage but unreachable: ids are never
    ///         reused, so no future policy can inherit them.
    function revokePolicy(
        uint256 policyId
    ) external {
        Policy storage p = _owned(policyId);
        address agent = p.agent;

        delete policyOf[agent];
        delete _policies[policyId];

        uint256[] storage ids = _policiesOf[msg.sender];
        uint256 index = _positionPlusOne[policyId] - 1;
        uint256 last = ids[ids.length - 1];
        ids[index] = last;
        _positionPlusOne[last] = index + 1;
        ids.pop();
        delete _positionPlusOne[policyId];

        emit PolicyRevoked(msg.sender, policyId, agent);
    }

    /*//////////////////////////////////////////////////////////////
                          OWNER: THE KILL SWITCHES
    //////////////////////////////////////////////////////////////*/

    /// @notice Stop or resume one agent immediately.
    /// @dev    A direct owner -> chain write with no backend, indexer or relayer in the path,
    ///         so it keeps working when every other part of Tollgate is down. That is a
    ///         requirement, not a nicety.
    function setPaused(
        uint256 policyId,
        bool paused
    ) external {
        Policy storage p = _owned(policyId);
        p.paused = paused;
        emit PauseSet(msg.sender, policyId, paused);
    }

    /// @notice Stop or resume every one of this caller's agents in one transaction.
    /// @dev    Needs no policy to exist, so an owner can arm it before creating any.
    ///         Resuming here does not lift an individual policy's own pause.
    function setOwnerPaused(
        bool paused
    ) external {
        ownerPaused[msg.sender] = paused;
        emit OwnerPauseSet(msg.sender, paused);
    }

    /*//////////////////////////////////////////////////////////////
                           OWNER: POLICY CHANGES
    //////////////////////////////////////////////////////////////*/

    function setCaps(
        uint256 policyId,
        uint128 budgetCap,
        uint128 perTxCap
    ) external {
        Policy storage p = _owned(policyId);
        // Lowering the budget below what has already gone out would make `spent`
        // exceed `budgetCap` and break the headline invariant.
        if (budgetCap < p.spent) revert BudgetBelowSpent(budgetCap, p.spent);
        p.budgetCap = budgetCap;
        p.perTxCap = perTxCap;
        emit CapsUpdated(msg.sender, policyId, budgetCap, perTxCap);
    }

    /// @dev Settles the bucket at the old rate before the new one takes effect, so a
    ///      rate change can never retroactively mint or destroy available headroom.
    function setVelocity(
        uint256 policyId,
        uint128 bucketCapacity,
        uint128 refillPerSecond
    ) external {
        Policy storage p = _owned(policyId);

        uint128 settled = _availableNow(p);
        p.bucketCapacity = bucketCapacity;
        p.refillPerSecond = refillPerSecond;
        p.available = settled > bucketCapacity ? bucketCapacity : settled;
        p.lastRefill = uint64(block.timestamp);

        emit VelocityUpdated(msg.sender, policyId, bucketCapacity, refillPerSecond);
    }

    function setExpiry(
        uint256 policyId,
        uint64 expiry
    ) external {
        Policy storage p = _owned(policyId);
        p.expiry = expiry;
        emit ExpiryUpdated(msg.sender, policyId, expiry);
    }

    /// @notice Rotate the session key — the response to a suspected agent compromise.
    ///         The policy keeps its spend history and its allowlist; only the key changes.
    function setAgent(
        uint256 policyId,
        address newAgent
    ) external {
        if (newAgent == address(0)) revert ZeroAddress();
        Policy storage p = _owned(policyId);

        uint256 boundTo = policyOf[newAgent];
        if (boundTo != 0 && boundTo != policyId) revert AgentAlreadyBound(newAgent, boundTo);

        address previous = p.agent;
        delete policyOf[previous];
        p.agent = newAgent;
        policyOf[newAgent] = policyId;

        emit AgentRotated(msg.sender, policyId, newAgent, previous);
    }

    function setPayee(
        uint256 policyId,
        address payee,
        bool allowed
    ) public {
        if (payee == address(0)) revert ZeroAddress();
        // This contract holds nothing and can send nothing. USDC transferred here is
        // unrecoverable, and an owner allowlisting it would be one typo away from burning
        // their budget. Refusing costs nothing and removes the footgun entirely.
        if (payee == address(this)) revert InvalidPayee(payee);
        _owned(policyId);
        isAllowedPayee[policyId][payee] = allowed;
        emit PayeeSet(msg.sender, policyId, payee, allowed);
    }

    function setPayees(
        uint256 policyId,
        address[] calldata payees,
        bool allowed
    ) external {
        for (uint256 i; i < payees.length; ++i) {
            setPayee(policyId, payees[i], allowed);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Spend from the owner's wallet to an allowlisted payee, if policy permits.
    /// @dev    Caller must be a bound agent. Reverts with PolicyViolation otherwise.
    ///         Funds move owner -> payee. They never rest in this contract.
    function spend(
        address payee,
        uint256 amount
    ) external nonReentrant returns (uint128 spentTotal) {
        (Reason r, uint128 total) = _attempt(payee, amount);
        // The revert discards the Refused log along with everything else, which is why a
        // caller that wants the refusal on the record uses `trySpend` instead.
        if (r != Reason.OK) revert PolicyViolation(r);
        return total;
    }

    /// @notice Attempt a spend without reverting when policy refuses it.
    /// @dev    Returns the reason instead of reverting, and emits `Refused` so the attempt
    ///         survives on chain. This is the entry point that makes an owner's audit log
    ///         complete: with `spend` alone, a refusal leaves no trace anywhere.
    ///
    ///         The caller MUST check the return value. A caller that ignores it will treat
    ///         a refusal as a payment — which is why `spend` remains the reverting default
    ///         and this is the deliberate opt-in.
    /// @return reason `OK` if the funds moved, otherwise why they did not.
    function trySpend(
        address payee,
        uint256 amount
    ) external nonReentrant returns (Reason reason) {
        (reason,) = _attempt(payee, amount);
    }

    /// @dev The one implementation. `spend` and `trySpend` differ only in what they do
    ///      with the result, so they cannot diverge on what the policy actually is.
    function _attempt(
        address payee,
        uint256 amount
    ) internal returns (Reason, uint128) {
        uint256 policyId = policyOf[msg.sender];
        if (policyId == 0) {
            emit Refused(address(0), msg.sender, payee, 0, amount, Reason.NO_POLICY);
            return (Reason.NO_POLICY, 0);
        }

        Policy storage p = _policies[policyId];
        address owner = p.owner;

        Reason r = _evaluate(p, policyId, msg.sender, payee, amount);
        if (r != Reason.OK) {
            emit Refused(owner, msg.sender, payee, policyId, amount, r);
            return (r, p.spent);
        }

        // ---- effects, then interaction ----
        // casting to 'uint128' is safe because _evaluate returned OK, which it only
        // does after rejecting any amount above type(uint128).max.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amt = uint128(amount);
        uint128 avail = _availableNow(p);

        p.spent += amt;
        p.available = avail - amt;
        p.lastRefill = uint64(block.timestamp);
        uint128 spentTotal = p.spent;

        emit Spent(owner, msg.sender, payee, policyId, amount, spentTotal, p.available);

        USDC.safeTransferFrom(owner, payee, amount);

        return (Reason.OK, spentTotal);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Would this spend be permitted right now? Returns a reason code instead of
    ///         reverting, so the SDK and dashboard can explain a block before one happens.
    /// @dev    This is the same evaluation `spend` performs. It cannot drift from it.
    function checkTransfer(
        address agent,
        address payee,
        uint256 amount
    ) external view returns (Reason) {
        uint256 policyId = policyOf[agent];
        if (policyId == 0) return Reason.NO_POLICY;
        return _evaluate(_policies[policyId], policyId, agent, payee, amount);
    }

    /// @notice The owner an agent spends for, or zero if the key is unbound.
    function ownerOf(
        address agent
    ) external view returns (address) {
        return _policies[policyOf[agent]].owner;
    }

    /// @notice Every live policy this owner has, in no guaranteed order.
    function policiesOf(
        address owner
    ) external view returns (uint256[] memory) {
        return _policiesOf[owner];
    }

    /// @notice Velocity headroom for a policy as of this block.
    function availableNow(
        uint256 policyId
    ) external view returns (uint128) {
        return _availableNow(_policies[policyId]);
    }

    /// @notice Remaining lifetime budget.
    function remainingBudget(
        uint256 policyId
    ) external view returns (uint128) {
        Policy storage p = _policies[policyId];
        return p.budgetCap > p.spent ? p.budgetCap - p.spent : 0;
    }

    function getPolicy(
        uint256 policyId
    ) external view returns (Policy memory) {
        return _policies[policyId];
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev The single implementation of policy. Both `spend` and `checkTransfer` use it.
    function _evaluate(
        Policy storage p,
        uint256 policyId,
        address agent,
        address payee,
        uint256 amount
    ) internal view returns (Reason) {
        if (!p.exists) return Reason.NO_POLICY;
        if (p.agent != agent) return Reason.NOT_AGENT;
        if (p.paused || ownerPaused[p.owner]) return Reason.PAUSED;
        if (p.expiry != 0 && block.timestamp > p.expiry) return Reason.EXPIRED;
        if (amount == 0) return Reason.AMOUNT_ZERO;
        if (!isAllowedPayee[policyId][payee]) return Reason.PAYEE_NOT_ALLOWED;

        // uint128 is the widest amount the policy fields can express. Anything larger
        // cannot fit under any cap, so reject it before narrowing.
        if (amount > type(uint128).max) return Reason.EXCEEDS_PER_TX;
        // casting to 'uint128' is safe because the line above rejects anything wider.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amt = uint128(amount);

        if (amt > p.perTxCap) return Reason.EXCEEDS_PER_TX;
        if (uint256(p.spent) + amt > p.budgetCap) return Reason.EXCEEDS_BUDGET;
        if (amt > _availableNow(p)) return Reason.EXCEEDS_VELOCITY;

        // Pre-flight the transfer itself so the caller learns the real reason rather
        // than a bare ERC-20 failure.
        if (USDC.allowance(p.owner, address(this)) < amount) return Reason.INSUFFICIENT_ALLOWANCE;
        if (USDC.balanceOf(p.owner) < amount) return Reason.INSUFFICIENT_BALANCE;

        return Reason.OK;
    }

    /// @dev Token bucket. Headroom refills continuously at `refillPerSecond` and is
    ///      capped at `bucketCapacity`, so outflow over any window of length T is at
    ///      most capacity + T*rate — with no burst at a window boundary, which is the
    ///      failure mode a tumbling window has. See docs/decisions/0002.
    function _availableNow(
        Policy storage p
    ) internal view returns (uint128) {
        if (!p.exists) return 0;
        uint256 elapsed = block.timestamp - p.lastRefill;
        // uint64 elapsed * uint128 rate cannot overflow uint256.
        uint256 refilled = uint256(p.available) + elapsed * uint256(p.refillPerSecond);
        uint256 capacity = p.bucketCapacity;
        return uint128(refilled > capacity ? capacity : refilled);
    }
}
