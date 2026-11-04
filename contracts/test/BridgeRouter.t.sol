// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaToken} from "../src/MesaToken.sol";
import {MesaBridgeRouter} from "../src/MesaBridgeRouter.sol";

contract RejectsHype {
    receive() external payable {
        revert("no");
    }
}

/// The bridge-and-buy target: buys go through, and anything that would fail
/// sends the HYPE to the recipient instead of keeping it.
contract BridgeRouterTest is Test, Deployers {
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    MesaHook hook;
    MesaBridgeRouter router;
    MesaToken token;
    address genesis = makeAddr("genesis");
    address feeTo = makeAddr("feeTo");
    address bridged = makeAddr("bridged"); // the deposit's sender on Elysium
    address alice = makeAddr("alice");

    function setUp() public {
        deployFreshManagerAndRouters();
        address at = address(FLAGS | (uint160(0x4444) << 144));
        deployCodeTo(
            "out/MesaHook.sol/MesaHook.json",
            abi.encode(
                manager, uint16(7_000), int24(173_200), genesis, makeAddr("o"), makeAddr("k"), 10 ether, makeAddr("qa")
            ),
            at
        );
        hook = MesaHook(at);
        router = new MesaBridgeRouter(manager, address(hook));
        vm.prank(genesis);
        (address t,) = hook.launch(MesaHook.LaunchParams("Mesa", "MESA", "", feeTo, 100, 100, 0, 60, 100));
        token = MesaToken(t);
        vm.deal(bridged, 1_000 ether);
    }

    function test_buysForTheRecipient() public {
        vm.prank(bridged);
        // 0.2 HYPE is under the launch's 1%-of-supply cap per transaction.
        uint256 out = router.buy{value: 0.2 ether}(address(token), 1, alice);
        assertGt(out, 0);
        assertEq(token.balanceOf(alice), out);
        assertEq(address(router).balance, 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(hook.accrued(feeTo), 0.0014 ether, "normal Mesa fee");
    }

    function test_refundsWhenPriceMoved() public {
        vm.prank(bridged);
        uint256 out = router.buy{value: 1 ether}(address(token), type(uint256).max, alice);
        assertEq(out, 0);
        assertEq(alice.balance, 1 ether, "HYPE refunded to the recipient on Elysium");
        assertEq(token.balanceOf(alice), 0);
    }

    function test_refundsForUnknownToken() public {
        vm.prank(bridged);
        router.buy{value: 1 ether}(makeAddr("notAToken"), 0, alice);
        assertEq(alice.balance, 1 ether);
    }

    function test_refundsWhenOverTheLaunchCap() public {
        // 1% cap per transaction during the first 60 seconds: 50 HYPE buys far more.
        vm.prank(bridged);
        router.buy{value: 50 ether}(address(token), 0, alice);
        assertEq(alice.balance, 50 ether);
        vm.warp(block.timestamp + 61);
        vm.prank(bridged);
        assertGt(router.buy{value: 50 ether}(address(token), 0, alice), 0);
    }

    function test_revertsIfTheRecipientRefusesARefund() public {
        // The bridge message then stays redeemable, so nothing is lost.
        address r = address(new RejectsHype());
        vm.prank(bridged);
        vm.expectRevert(MesaBridgeRouter.RefundFailed.selector);
        router.buy{value: 1 ether}(address(token), type(uint256).max, r);
    }

    function test_innerBuyIsSelfOnly() public {
        vm.expectRevert(MesaBridgeRouter.OnlySelf.selector);
        router.buyOrRevert{value: 1 ether}(address(token), 0, alice);
    }
}
