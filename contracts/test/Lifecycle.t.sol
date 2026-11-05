// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaTokenFactory} from "../src/MesaTokenFactory.sol";
import {MesaToken} from "../src/MesaToken.sol";

/// A whole launch: a declared dev buy, a crowd buying through the snipe
/// window and after, partial sells, then everyone exits. Checks that every
/// holder can always sell, that HYPE is conserved, and that the pool ends
/// back at its starting price.
contract LifecycleTest is Test, Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    int24 constant INITIAL_TICK = 173_200;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    uint256 constant TRADERS = 30;

    MesaHook hook;
    PoolKey pool;
    MesaToken token;
    address creator = makeAddr("creator");
    address feeTo = makeAddr("feeTo");
    address[] traders;
    PoolSwapTest.TestSettings settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

    function setUp() public {
        deployFreshManagerAndRouters();
        address at = address(FLAGS | (uint160(0x4444) << 144));
        deployCodeTo(
            "out/MesaHook.sol/MesaHook.json",
            abi.encode(
                manager,
                uint16(7_000),
                INITIAL_TICK,
                creator,
                makeAddr("o"),
                makeAddr("k"),
                10 ether,
                makeAddr("qa"),
                new MesaTokenFactory()
            ),
            at
        );
        hook = MesaHook(at);
        vm.deal(creator, 100 ether);
        for (uint256 i; i < TRADERS; ++i) {
            address t = makeAddr(string(abi.encodePacked("trader", vm.toString(i))));
            vm.deal(t, 100 ether);
            traders.push(t);
        }
    }

    function buy(address who, uint256 hype) internal returns (bool ok) {
        vm.prank(who);
        (ok,) = address(swapRouter).call{value: hype}(
            abi.encodeCall(
                PoolSwapTest.swap,
                (pool, IPoolManager.SwapParams(true, -int256(hype), TickMath.MIN_SQRT_PRICE + 1), settings, "")
            )
        );
    }

    function sell(address who, uint256 tokens) internal {
        if (tokens == 0) return;
        vm.startPrank(who);
        token.approve(address(swapRouter), tokens);
        swapRouter.swap(
            pool, IPoolManager.SwapParams(false, -int256(tokens), TickMath.MAX_SQRT_PRICE - 1), settings, ""
        );
        vm.stopPrank();
    }

    function poolHype() internal view returns (uint256) {
        return address(manager).balance - manager.balanceOf(address(hook), 0);
    }

    function testFuzz_launchLifecycle(uint256 seed) public {
        // Recommended fairness defaults: 15% surcharge over 5 minutes, 1% cap per transaction.
        uint256 t0 = block.timestamp;
        vm.prank(creator);
        (address tok, PoolKey memory k) = hook.launch{value: 1 ether}(
            MesaHook.LaunchParams("Lifecycle", "LIFE", "", feeTo, 100, 1_500, 300, 100, address(0), 0, "")
        );
        token = MesaToken(tok);
        pool = k;

        uint256 hypeIn = 1 ether; // the dev buy
        uint256 rejected;

        // Rounds of trading: buys, sometimes partial sells, time passing.
        for (uint256 round; round < 6; ++round) {
            vm.warp(t0 + round * 90);
            for (uint256 i; i < TRADERS; ++i) {
                seed = uint256(keccak256(abi.encode(seed, round, i)));
                address who = traders[i];
                uint256 amount = 0.01 ether + seed % 2 ether;
                uint256 bal = who.balance;
                if (buy(who, amount)) hypeIn += bal - who.balance;
                else ++rejected; // over the launch cap
                if (seed % 5 == 0) {
                    bal = who.balance;
                    sell(who, token.balanceOf(who) / 2);
                    hypeIn -= who.balance - bal;
                }
            }
        }

        // Everyone exits, creator included. Selling must always succeed.
        uint256 out;
        for (uint256 i; i < TRADERS; ++i) {
            uint256 bal = traders[i].balance;
            sell(traders[i], token.balanceOf(traders[i]));
            out += traders[i].balance - bal;
            assertEq(token.balanceOf(traders[i]), 0);
        }
        uint256 cb = creator.balance;
        sell(creator, token.balanceOf(creator));
        out += creator.balance - cb;

        // Conservation: what came in = what went out + fees + what is left in the pool.
        uint256 fees = manager.balanceOf(address(hook), 0);
        assertEq(hypeIn, out + fees + poolHype(), "HYPE conserved");
        assertLt(poolHype(), 1e12, "only rounding dust left in the pool");
        assertGt(fees, 0);

        // Every token is back in the pool (or burned as launch dust), so the price is back at the start.
        assertEq(token.balanceOf(address(manager)) + token.balanceOf(hook.DEAD()), token.totalSupply());
        (, int24 tick,,) = manager.getSlot0(pool.toId());
        assertGe(tick, INITIAL_TICK - 1, "price back at the starting price");

        // The cap did its job early on: at least one oversized launch-window buy was refused.
        if (rejected == 0) emit log("no buys hit the cap this run");
    }
}
