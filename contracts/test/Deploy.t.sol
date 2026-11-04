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
            initialTick: 161_200,
            genesis: makeAddr("genesis"),
            owner: makeAddr("owner"),
            keeper: makeAddr("keeper"),
            maxPerCall: 10 ether
        });
    }

    function test_deployScriptMinesAValidHook() public {
        (MesaHook hook, BuybackBurner burner,) = d.deploy(settings());
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, uint160(0x2AEC), "permission bits");
        assertEq(hook.protocolRecipient(), address(burner));
        assertEq(address(burner.hook()), address(hook));
        assertEq(hook.creatorShareBps(), 7_000);
        assertEq(hook.initialTick(), 161_200);
        assertEq(hook.genesisLauncher(), makeAddr("genesis"));
        // The production build, with room under the 24,576-byte limit.
        assertLt(address(hook).code.length, 20_000, "deployed from the production profile");
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
