// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PolicyEngine} from "../src/PolicyEngine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console} from "forge-std/Script.sol";

/// @notice Seeds the demo policy on a deployed PolicyEngine.
///
/// @dev  forge script script/SeedDemo.s.sol:SeedDemo --rpc-url $ARC_RPC_URL --broadcast
///
///       Deliberately approves EXACTLY the budget rather than type(uint256).max. The
///       allowance is then a hard ceiling that holds even if PolicyEngine is wrong —
///       see docs/decisions/0001. Any demo that approves max throws that away.
contract SeedDemo is Script {
    // Sized so the constraints actually bind on camera rather than in theory.
    uint128 constant BUDGET = 10e6; //  10 USDC lifetime
    uint128 constant PER_TX = 2e6; //    2 USDC per payment
    uint128 constant BUCKET = 4e6; //    4 USDC burst — two payments drains it
    // ~4 USDC/hour: 4_000_000 / 3600 = 1111.11, truncated down. Truncating down is the
    // safe direction — policy must never refill faster than the owner asked for.
    uint128 constant REFILL = 1111;

    function run() external {
        uint256 ownerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(ownerKey);
        address agent = vm.envAddress("AGENT_ADDRESS");
        address payee = vm.envAddress("PAYEE_ADDRESS");

        PolicyEngine engine = PolicyEngine(vm.envAddress("POLICY_ENGINE_ADDRESS"));
        IERC20 usdc = engine.USDC();

        console.log("engine :", address(engine));
        console.log("owner  :", owner);
        console.log("agent  :", agent);
        console.log("payee  :", payee);

        vm.startBroadcast(ownerKey);

        // Exactly the budget. Never max.
        usdc.approve(address(engine), BUDGET);

        uint256 policyId = engine.createPolicy(agent, BUDGET, PER_TX, BUCKET, REFILL, 0);
        engine.setPayee(policyId, payee, true);

        vm.stopBroadcast();

        console.log("");
        console.log("policy seeded, id:", policyId);
        console.log("  budget cap  : 10 USDC");
        console.log("  per-tx cap  :  2 USDC");
        console.log("  bucket      :  4 USDC burst, ~4 USDC/hour refill");
        console.log("  allowlist   : payee only");
        console.log("  allowance   : 10 USDC (exact, not max)");
    }
}
