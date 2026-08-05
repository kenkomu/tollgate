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
///            their budget, never type(uint256).max. If this contract is wrong, the
///            blast radius is the outstanding allowance rather than the whole wallet.
///
///         3. ONE SOURCE OF POLICY TRUTH. `checkTransfer` (a view, used by the SDK for
///            pre-flight) and `spend` (enforcement) both delegate to `_evaluate`. They
///            cannot drift, because there is only one implementation.
///
///         4. DECIMALS. On Arc, native USDC is 18 decimals for gas accounting while the
///            ERC-20 interface is 6. Every amount in this contract is 6-decimal ERC-20
///            units. This contract never reads a native balance.
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
        PAUSED, //                 3  owner hit the kill switch
        EXPIRED, //                4  session key past its expiry
        PAYEE_NOT_ALLOWED, //      5  payee is not on the owner's allowlist
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
        bool paused; //             the kill switch
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
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The USDC ERC-20 interface. On Arc this is the predeploy at
    ///         0x3600000000000000000000000000000000000000 (6 decimals).
    IERC20 public immutable USDC;

    /// @dev One policy per owner — a deliberate v1 constraint. Multi-agent orgs get a
    ///      registry in a later version; see docs/decisions/0004.
    mapping(address owner => Policy) private _policies;

    /// @notice Reverse index so an agent can call `spend` without naming its owner.
    mapping(address agent => address owner) public ownerOf;

    /// @notice Strict allowlist. An agent may only pay addresses the owner named.
    mapping(address owner => mapping(address payee => bool)) public isAllowedPayee;

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    event PolicyCreated(
        address indexed owner,
        address indexed agent,
        uint128 budgetCap,
        uint128 perTxCap,
        uint128 bucketCapacity,
        uint128 refillPerSecond,
        uint64 expiry
    );
    event CapsUpdated(address indexed owner, uint128 budgetCap, uint128 perTxCap);
    event VelocityUpdated(address indexed owner, uint128 bucketCapacity, uint128 refillPerSecond);
    event AgentRotated(address indexed owner, address indexed previousAgent, address indexed newAgent);
    event ExpiryUpdated(address indexed owner, uint64 expiry);
    event PayeeSet(address indexed owner, address indexed payee, bool allowed);
    event PauseSet(address indexed owner, bool paused);
    event PolicyRevoked(address indexed owner, address indexed agent);
    event Spent(
        address indexed owner,
        address indexed agent,
        address indexed payee,
        uint256 amount,
        uint128 spentTotal,
        uint128 availableAfter
    );

    /*//////////////////////////////////////////////////////////////
                                  ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice A spend was refused. `reason` is the machine-readable code the SDK renders.
    error PolicyViolation(Reason reason);
    error NoPolicy();
    error PolicyExists();
    error AgentAlreadyBound(address agent, address existingOwner);
    error ZeroAddress();
    error BudgetBelowSpent(uint128 requested, uint128 alreadySpent);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(IERC20 usdc) {
        if (address(usdc) == address(0)) revert ZeroAddress();
        USDC = usdc;
    }

    /*//////////////////////////////////////////////////////////////
                            OWNER: LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Create this caller's policy and bind a session key to it.
    /// @param agent            the session key permitted to spend
    /// @param budgetCap        lifetime ceiling, 6-decimal USDC
    /// @param perTxCap         ceiling on any single transfer
    /// @param bucketCapacity   velocity burst ceiling — the most spendable at once when full
    /// @param refillPerSecond  velocity sustained rate
    /// @param expiry           unix seconds; 0 means never expires
    function createPolicy(
        address agent,
        uint128 budgetCap,
        uint128 perTxCap,
        uint128 bucketCapacity,
        uint128 refillPerSecond,
        uint64 expiry
    ) external {
        if (agent == address(0)) revert ZeroAddress();
        Policy storage p = _policies[msg.sender];
        if (p.exists) revert PolicyExists();

        address boundTo = ownerOf[agent];
        if (boundTo != address(0)) revert AgentAlreadyBound(agent, boundTo);

        p.exists = true;
        p.agent = agent;
        p.budgetCap = budgetCap;
        p.perTxCap = perTxCap;
        p.bucketCapacity = bucketCapacity;
        p.refillPerSecond = refillPerSecond;
        p.expiry = expiry;
        // The bucket starts full: a fresh policy can spend up to its burst immediately.
        p.available = bucketCapacity;
        p.lastRefill = uint64(block.timestamp);

        ownerOf[agent] = msg.sender;

        emit PolicyCreated(msg.sender, agent, budgetCap, perTxCap, bucketCapacity, refillPerSecond, expiry);
    }

    /// @notice Tear down the policy and unbind the agent. Does not touch funds —
    ///         the owner should also set the USDC allowance to zero.
    function revokePolicy() external {
        Policy storage p = _policies[msg.sender];
        if (!p.exists) revert NoPolicy();

        address agent = p.agent;
        delete ownerOf[agent];
        delete _policies[msg.sender];

        emit PolicyRevoked(msg.sender, agent);
    }

    /*//////////////////////////////////////////////////////////////
                          OWNER: THE KILL SWITCH
    //////////////////////////////////////////////////////////////*/

    /// @notice Stop or resume all spending immediately.
    /// @dev    This is the kill switch. It is a direct owner -> chain write with no
    ///         backend, indexer or relayer in the path, so it keeps working when every
    ///         other part of Tollgate is down. That is a requirement, not a nicety.
    function setPaused(bool paused) external {
        Policy storage p = _policies[msg.sender];
        if (!p.exists) revert NoPolicy();
        p.paused = paused;
        emit PauseSet(msg.sender, paused);
    }

    /*//////////////////////////////////////////////////////////////
                           OWNER: POLICY CHANGES
    //////////////////////////////////////////////////////////////*/

    function setCaps(uint128 budgetCap, uint128 perTxCap) external {
        Policy storage p = _policies[msg.sender];
        if (!p.exists) revert NoPolicy();
        // Lowering the budget below what has already gone out would make `spent`
        // exceed `budgetCap` and break the headline invariant.
        if (budgetCap < p.spent) revert BudgetBelowSpent(budgetCap, p.spent);
        p.budgetCap = budgetCap;
        p.perTxCap = perTxCap;
        emit CapsUpdated(msg.sender, budgetCap, perTxCap);
    }

    /// @dev Settles the bucket at the old rate before the new one takes effect, so a
    ///      rate change can never retroactively mint or destroy available headroom.
    function setVelocity(uint128 bucketCapacity, uint128 refillPerSecond) external {
        Policy storage p = _policies[msg.sender];
        if (!p.exists) revert NoPolicy();

        uint128 settled = _availableNow(p);
        p.bucketCapacity = bucketCapacity;
        p.refillPerSecond = refillPerSecond;
        p.available = settled > bucketCapacity ? bucketCapacity : settled;
        p.lastRefill = uint64(block.timestamp);

        emit VelocityUpdated(msg.sender, bucketCapacity, refillPerSecond);
    }

    function setExpiry(uint64 expiry) external {
        Policy storage p = _policies[msg.sender];
        if (!p.exists) revert NoPolicy();
        p.expiry = expiry;
        emit ExpiryUpdated(msg.sender, expiry);
    }

    /// @notice Rotate the session key — the response to a suspected agent compromise.
    function setAgent(address newAgent) external {
        if (newAgent == address(0)) revert ZeroAddress();
        Policy storage p = _policies[msg.sender];
        if (!p.exists) revert NoPolicy();

        address boundTo = ownerOf[newAgent];
        if (boundTo != address(0) && boundTo != msg.sender) revert AgentAlreadyBound(newAgent, boundTo);

        address previous = p.agent;
        delete ownerOf[previous];
        p.agent = newAgent;
        ownerOf[newAgent] = msg.sender;

        emit AgentRotated(msg.sender, previous, newAgent);
    }

    function setPayee(address payee, bool allowed) public {
        if (payee == address(0)) revert ZeroAddress();
        if (!_policies[msg.sender].exists) revert NoPolicy();
        isAllowedPayee[msg.sender][payee] = allowed;
        emit PayeeSet(msg.sender, payee, allowed);
    }

    function setPayees(address[] calldata payees, bool allowed) external {
        for (uint256 i; i < payees.length; ++i) {
            setPayee(payees[i], allowed);
        }
    }

    /*//////////////////////////////////////////////////////////////
                               ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Spend from the owner's wallet to an allowlisted payee, if policy permits.
    /// @dev    Caller must be the registered agent. Reverts with PolicyViolation otherwise.
    ///         Funds move owner -> payee. They never rest in this contract.
    function spend(address payee, uint256 amount) external nonReentrant returns (uint128 spentTotal) {
        address owner = ownerOf[msg.sender];
        if (owner == address(0)) revert PolicyViolation(Reason.NO_POLICY);

        Policy storage p = _policies[owner];

        Reason r = _evaluate(p, owner, msg.sender, payee, amount);
        if (r != Reason.OK) revert PolicyViolation(r);

        // ---- effects, then interaction ----
        // casting to 'uint128' is safe because _evaluate returned OK, which it only
        // does after rejecting any amount above type(uint128).max.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 amt = uint128(amount);
        uint128 avail = _availableNow(p);

        p.spent += amt;
        p.available = avail - amt;
        p.lastRefill = uint64(block.timestamp);
        spentTotal = p.spent;

        emit Spent(owner, msg.sender, payee, amount, spentTotal, p.available);

        USDC.safeTransferFrom(owner, payee, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Would this spend be permitted right now? Returns a reason code instead of
    ///         reverting, so the SDK and dashboard can explain a block before one happens.
    /// @dev    This is the same evaluation `spend` performs. It cannot drift from it.
    function checkTransfer(address agent, address payee, uint256 amount) external view returns (Reason) {
        address owner = ownerOf[agent];
        if (owner == address(0)) return Reason.NO_POLICY;
        return _evaluate(_policies[owner], owner, agent, payee, amount);
    }

    /// @notice Velocity headroom for an owner as of this block.
    function availableNow(address owner) external view returns (uint128) {
        return _availableNow(_policies[owner]);
    }

    /// @notice Remaining lifetime budget.
    function remainingBudget(address owner) external view returns (uint128) {
        Policy storage p = _policies[owner];
        return p.budgetCap > p.spent ? p.budgetCap - p.spent : 0;
    }

    function getPolicy(address owner) external view returns (Policy memory) {
        return _policies[owner];
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev The single implementation of policy. Both `spend` and `checkTransfer` use it.
    function _evaluate(Policy storage p, address owner, address agent, address payee, uint256 amount)
        internal
        view
        returns (Reason)
    {
        if (!p.exists) return Reason.NO_POLICY;
        if (p.agent != agent) return Reason.NOT_AGENT;
        if (p.paused) return Reason.PAUSED;
        if (p.expiry != 0 && block.timestamp > p.expiry) return Reason.EXPIRED;
        if (amount == 0) return Reason.AMOUNT_ZERO;
        if (!isAllowedPayee[owner][payee]) return Reason.PAYEE_NOT_ALLOWED;

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
        if (USDC.allowance(owner, address(this)) < amount) return Reason.INSUFFICIENT_ALLOWANCE;
        if (USDC.balanceOf(owner) < amount) return Reason.INSUFFICIENT_BALANCE;

        return Reason.OK;
    }

    /// @dev Token bucket. Headroom refills continuously at `refillPerSecond` and is
    ///      capped at `bucketCapacity`, so outflow over any window of length T is at
    ///      most capacity + T*rate — with no burst at a window boundary, which is the
    ///      failure mode a tumbling window has. See docs/decisions/0002.
    function _availableNow(Policy storage p) internal view returns (uint128) {
        if (!p.exists) return 0;
        uint256 elapsed = block.timestamp - p.lastRefill;
        // uint64 elapsed * uint128 rate cannot overflow uint256.
        uint256 refilled = uint256(p.available) + elapsed * uint256(p.refillPerSecond);
        uint256 capacity = p.bucketCapacity;
        return uint128(refilled > capacity ? capacity : refilled);
    }
}
