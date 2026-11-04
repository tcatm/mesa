// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {MesaHook} from "../src/MesaHook.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";

/// Calls `Deploy.deploy` with explicit settings rather than env vars, which
/// are process-wide and would leak between parallel tests.
contract DeployTest is Test {
    Deploy d;

    function setUp() public {
        d = new Deploy();
    }

    function settings() internal returns (Deploy.Settings memory) {
        return Deploy.Settings({
            expectedChainId: block.chainid,
            rehearsal: true,
            poolManager: address(0),
            creatorShareBps: 7_000,
            initialTick: 173_200,
            genesis: makeAddr("genesis"),
            owner: makeAddr("owner"),
            keeper: makeAddr("keeper"),
            maxPerCall: 10 ether,
            quoteAdmin: makeAddr("quoteAdmin")
        });
    }

    function test_deployScriptMinesAValidHook() public {
        (MesaHook hook, BuybackBurner burner,) = d.deploy(settings());
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, uint160(0x2AEC), "permission bits");
        assertEq(hook.protocolRecipient(), address(burner));
        assertEq(address(burner.hook()), address(hook));
        assertEq(hook.creatorShareBps(), 7_000);
        assertEq(hook.initialTick(), 173_200);
        assertEq(hook.genesisLauncher(), makeAddr("genesis"));
        assertEq(hook.quoteRegistry().admin(), makeAddr("quoteAdmin"));
        // The production build, not the PoolManager's high-runs profile, and under the 24,576-byte limit.
        assertEq(
            address(hook).code.length,
            vm.getDeployedCode("out/MesaHook.sol/MesaHook.json").length,
            "deployed from the production profile"
        );
        assertLt(address(hook).code.length, 24_576);
    }

    function test_rehearsalRunsOnElysiumTestnet() public {
        vm.chainId(99_801);
        Deploy.Settings memory s = settings();
        s.expectedChainId = 99_801;
        d.check(s);
    }

    function test_refusesWrongChain() public {
        Deploy.Settings memory s = settings();
        s.expectedChainId = 1;
        vm.expectRevert(bytes("wrong chain"));
        d.check(s);
    }

    function test_refusesRehearsalOnMainnet() public {
        vm.chainId(99_901);
        Deploy.Settings memory s = settings();
        s.expectedChainId = 99_901;
        vm.expectRevert(bytes("rehearsal only on testnet"));
        d.check(s);
    }

    function test_mainnetRequiresTheOfficialPoolManager() public {
        vm.chainId(99_901);
        Deploy.Settings memory s = settings();
        s.expectedChainId = 99_901;
        s.rehearsal = false;
        s.poolManager = 0x5fb015a49f5b35073f9Ce01C2aDb287A75F89600; // ElysPump's own PoolManager
        vm.expectRevert(bytes("not the official Elysium PoolManager"));
        d.check(s);
        s.poolManager = 0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1;
        d.check(s);
    }

    function test_refusesOutOfRangeValues() public {
        Deploy.Settings memory s = settings();
        s.creatorShareBps = 70_000;
        vm.expectRevert(bytes("CREATOR_SHARE_BPS > 10000"));
        d.check(s);

        s = settings();
        s.keeper = address(0);
        vm.expectRevert(bytes("zero address"));
        d.check(s);
    }
}
