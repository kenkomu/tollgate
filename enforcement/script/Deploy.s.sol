// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PolicyEngine} from "../src/PolicyEngine.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Script, console} from "forge-std/Script.sol";

/// @notice Deploys PolicyEngine to Arc.
///
/// @dev  Usage:
///         forge script script/Deploy.s.sol:Deploy \
///           --rpc-url $ARC_RPC_URL --broadcast --verify
///
///       Requires DEPLOYER_PRIVATE_KEY in the environment. Fund the deployer with
///       testnet USDC from https://faucet.circle.com (select Arc Testnet) — on Arc,
///       USDC is the gas token, so that same balance pays for the deployment.
contract Deploy is Script {
    /// @dev USDC's ERC-20 interface predeploy on Arc. Native and ERC-20 views share one
    ///      balance; this is the view that exposes approve/transferFrom, which is the
    ///      whole basis of allowance-based enforcement.
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (PolicyEngine engine) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);

        // Mainnet moves real money: refuse unless the operator has said so on purpose.
        if (block.chainid == 5042) {
            require(vm.envOr("CONFIRM_MAINNET", false), "mainnet deploy: set CONFIRM_MAINNET=true");
        } else {
            require(block.chainid == 5042002, "unexpected chain: expected Arc (5042) or Arc testnet (5042002)");
        }

        console.log("chain id  :", block.chainid);
        console.log("deployer  :", deployer);
        console.log("balance   :", deployer.balance, "(native USDC, 18dp)");
        console.log("usdc      :", usdc);

        require(deployer.balance > 0, "deployer has no gas: fund it at https://faucet.circle.com");
        require(usdc.code.length > 0, "no contract at USDC address");

        vm.startBroadcast(deployerKey);
        engine = new PolicyEngine(IERC20(usdc));
        vm.stopBroadcast();

        console.log("");
        console.log("PolicyEngine deployed:", address(engine));
        console.log("");
        console.log("Add to .env:");
        console.log("  POLICY_ENGINE_ADDRESS=%s", address(engine));
    }
}
