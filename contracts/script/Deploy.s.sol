// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IProtocolFees} from "v4-core/src/interfaces/IProtocolFees.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {Create2Deployer} from "../src/Create2Deployer.sol";
import {HookMiner} from "./HookMiner.sol";

/// @notice Deploys Mesa: Create2Deployer, then MesaHook at a mined address.
/// MesaHook's constructor deploys its BuybackBurner.
///
///   forge script script/Deploy.s.sol --rpc-url elysium_testnet --broadcast
///
/// Required env:
///   EXPECTED_CHAIN_ID     refuses to run on any other chain
///   POOL_MANAGER          the official Uniswap v4 PoolManager, verified on the
///                         explorer. Or DEPLOY_POOL_MANAGER=true to deploy one,
///                         allowed only on Elysium testnet (99801) and local
///                         chains (31337), for rehearsal.
///   MESA_GENESIS_LAUNCHER the only address that can make launch #1 ($MESA)
///   MESA_OWNER            BuybackBurner owner (sets the keeper; can renounce)
///   MESA_KEEPER           BuybackBurner keeper (runs buybacks)
/// Optional env (defaults):
///   CREATOR_SHARE_BPS     7000       share of base fees to a token's fee recipient
///   INITIAL_TICK          161200     starting price: about 100 HYPE virtual reserve
///   BUYBACK_MAX_PER_CALL  10 ether
///
/// This file deliberately does not import the PoolManager source: doing so
/// would compile MesaHook here with Uniswap's high optimizer settings instead
/// of the production profile.
contract Deploy is Script {
    uint256 internal constant ELYSIUM_TESTNET = 99_801;
    uint256 internal constant LOCAL = 31_337;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    struct Settings {
        uint256 expectedChainId;
        bool rehearsal;
        address poolManager;
        uint256 creatorShareBps;
        int256 initialTick;
        address genesis;
        address owner;
        address keeper;
        uint256 maxPerCall;
    }

    function run() external returns (MesaHook, BuybackBurner, IPoolManager) {
        return deploy(
            Settings({
                expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
                rehearsal: vm.envOr("DEPLOY_POOL_MANAGER", false),
                poolManager: vm.envOr("POOL_MANAGER", address(0)),
                creatorShareBps: vm.envOr("CREATOR_SHARE_BPS", uint256(7_000)),
                initialTick: vm.envOr("INITIAL_TICK", int256(161_200)),
                genesis: vm.envAddress("MESA_GENESIS_LAUNCHER"),
                owner: vm.envAddress("MESA_OWNER"),
                keeper: vm.envAddress("MESA_KEEPER"),
                maxPerCall: vm.envOr("BUYBACK_MAX_PER_CALL", uint256(10 ether))
            })
        );
    }

    function check(Settings memory s) public view {
        require(block.chainid == s.expectedChainId, "wrong chain");
        require(!s.rehearsal || block.chainid == ELYSIUM_TESTNET || block.chainid == LOCAL, "rehearsal only on testnet");
        require(s.creatorShareBps <= 10_000, "CREATOR_SHARE_BPS > 10000");
        require(s.initialTick > -887_272 && s.initialTick < 887_272, "INITIAL_TICK out of range");
        require(s.genesis != address(0) && s.owner != address(0) && s.keeper != address(0), "zero address");
        require(s.maxPerCall > 0, "BUYBACK_MAX_PER_CALL is 0");
    }

    function deploy(Settings memory s) public returns (MesaHook hook, BuybackBurner burner, IPoolManager manager) {
        check(s);
        vm.startBroadcast();
        if (s.rehearsal) {
            manager = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(s.owner)));
            console.log("PoolManager (rehearsal only)", address(manager));
        } else {
            manager = IPoolManager(s.poolManager);
            require(address(manager).code.length > 0, "no code at POOL_MANAGER");
            IProtocolFees(address(manager)).protocolFeeController(); // reverts unless it looks like a v4 PoolManager
        }

        Create2Deployer factory = new Create2Deployer();
        bytes memory initCode = abi.encodePacked(
            type(MesaHook).creationCode,
            abi.encode(
                manager, uint16(s.creatorShareBps), int24(s.initialTick), s.genesis, s.owner, s.keeper, s.maxPerCall
            )
        );
        (address expected, bytes32 salt) = HookMiner.find(address(factory), FLAGS, initCode);
        hook = MesaHook(factory.deploy(salt, initCode));
        vm.stopBroadcast();

        require(address(hook) == expected, "hook address mismatch");
        burner = BuybackBurner(payable(hook.protocolRecipient()));
        console.log("Create2Deployer", address(factory));
        console.log("MesaHook       ", address(hook));
        console.log("BuybackBurner  ", address(burner));
    }
}
