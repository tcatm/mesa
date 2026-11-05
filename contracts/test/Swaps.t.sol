// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaTokenFactory} from "../src/MesaTokenFactory.sol";
import {MesaToken} from "../src/MesaToken.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";

/// Runs any list of (pool, swap) inside one unlock and settles every
/// currency from / to its own balance.
contract BatchSwapper is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager immutable m;

    struct Op {
        PoolKey key;
        IPoolManager.SwapParams p;
    }

    constructor(IPoolManager m_) {
        m = m_;
    }

    function run(Op[] memory ops) external {
        m.unlock(abi.encode(ops));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        Op[] memory ops = abi.decode(data, (Op[]));
        for (uint256 i; i < ops.length; ++i) {
            m.swap(ops[i].key, ops[i].p, "");
        }
        for (uint256 i; i < ops.length; ++i) {
            _settle(ops[i].key.currency0);
            _settle(ops[i].key.currency1);
        }
        return "";
    }

    function _settle(Currency c) internal {
        int256 d = m.currencyDelta(address(this), c);
        if (d < 0) {
            if (c.isAddressZero()) {
                m.settle{value: uint256(-d)}();
            } else {
                m.sync(c);
                MesaToken(Currency.unwrap(c)).transfer(address(m), uint256(-d));
                m.settle();
            }
        } else if (d > 0) {
            m.take(c, address(this), uint256(d));
        }
    }

    receive() external payable {}
}

/// Swap-accounting checks across every swap kind, added during the
/// independent review of the fee and partial-fill fixes.
contract SwapsTest is Test, Deployers {
    int24 constant INITIAL_TICK = 173_200;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    MesaHook hook;
    BuybackBurner burner;
    address genesis = makeAddr("genesis");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

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
                genesis,
                makeAddr("o"),
                makeAddr("k"),
                10 ether,
                makeAddr("qa"),
                new MesaTokenFactory()
            ),
            at
        );
        hook = MesaHook(at);
        burner = BuybackBurner(payable(hook.protocolRecipient()));
        vm.prank(genesis);
        hook.launch(params(100, 100, 0, 0, 10_000));
        vm.deal(alice, 1e30);
        vm.deal(bob, 1e30);
    }

    function params(uint16 b, uint16 s, uint16 sn, uint32 secs, uint16 cap)
        internal
        view
        returns (MesaHook.LaunchParams memory)
    {
        return MesaHook.LaunchParams("T", "T", "", feeTo, b, sn, secs, cap, address(0), 0, "");
    }

    function claims() internal view returns (uint256) {
        return manager.balanceOf(address(hook), 0);
    }

    function sp(bool buy, int256 amt) internal pure returns (IPoolManager.SwapParams memory) {
        return IPoolManager.SwapParams(buy, amt, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function swap(address who, PoolKey memory k, IPoolManager.SwapParams memory p, uint256 value)
        internal
        returns (BalanceDelta d)
    {
        vm.prank(who);
        d = swapRouter.swap{value: value}(k, p, settings, "");
    }

    // ---------------------------------------------------------------- (2)(3)
    /// Full fills of every kind, at any fee configuration and with the
    /// PoolManager protocol fee on or off, never trip PartialFill, never trip
    /// HookDeltaExceedsSwapAmount, and pay `rate` of gross HYPE.
    /// Includes an exact-output sell that takes nearly all HYPE in the pool.
    function testFuzz_fullFillsAllKinds(
        uint96 hypeIn,
        uint16 buyFee,
        uint16 sellFee,
        uint16 sniper,
        uint32 elapsed,
        bool protocolFee
    ) public {
        // Up to 2x the 30 HYPE virtual reserve (about two thirds of supply), so the
        // later exact-output buy of a quarter of that still exists in the pool.
        hypeIn = uint96(bound(hypeIn, 1e9, 60 ether));
        buyFee = uint16(bound(buyFee, 100, 1_000));
        sellFee = buyFee; // one fee for buys and sells
        sniper = uint16(bound(sniper, 0, 3_000));
        elapsed = uint32(bound(elapsed, 0, 900));
        uint256 t0 = block.timestamp;
        vm.prank(alice);
        (address tok, PoolKey memory k) = hook.launch(params(buyFee, sellFee, sniper, 900, 10_000));
        MesaToken t = MesaToken(tok);
        if (protocolFee) {
            manager.setProtocolFeeController(address(this));
            manager.setProtocolFee(k, 1000 | (1000 << 12));
        }
        vm.warp(t0 + elapsed);
        uint256 buyRate = uint256(buyFee) * 1e14 + (sniper == 0 ? 0 : uint256(sniper) * 1e14 * (900 - elapsed) / 900);
        uint256 sellRate = uint256(sellFee) * 1e14;

        // exact-in buy
        uint256 c0 = claims();
        BalanceDelta d = swap(alice, k, sp(true, -int256(uint256(hypeIn))), hypeIn);
        assertApproxEqAbs(claims() - c0, uint256(hypeIn) * buyRate / 1e18, 2, "exact-in buy fee");
        uint256 tokens = uint256(uint128(d.amount1()));

        // exact-out buy for 1/4 of those tokens
        c0 = claims();
        d = swap(alice, k, sp(true, int256(tokens / 4 + 1)), uint256(hypeIn) * 4);
        uint256 paid = uint256(uint128(-d.amount0()));
        assertApproxEqAbs((claims() - c0) * 1e18, paid * buyRate, paid * 1e9 + 3e18, "exact-out buy fee share of gross");

        // exact-in sell of 1/4 of the balance
        vm.startPrank(alice);
        t.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
        c0 = claims();
        d = swap(alice, k, sp(false, -int256(t.balanceOf(alice) / 4)), 0);
        uint256 got = uint256(uint128(d.amount0()));
        assertApproxEqAbs((claims() - c0) * 1e18, (got + claims() - c0) * sellRate, (got) * 1e9 + 3e18, "exact-in sell");

        // exact-out sell draining (almost) all HYPE the pool holds
        deal(tok, alice, SUPPLY);
        uint256 poolHype = address(manager).balance - claims() - _otherPoolsHype();
        uint256 want = poolHype * (1e18 - sellRate) / 1e18;
        want -= want / 1e6 + 1e6; // rounding margin
        // (protocol fees accrued by the PoolManager also sit in its balance)
        c0 = claims();
        d = swap(alice, k, sp(false, int256(want)), 0);
        assertEq(uint256(uint128(d.amount0())), want, "exact-out sell got exactly what was asked");
        uint256 fee = claims() - c0;
        assertApproxEqAbs(fee * 1e18, (want + fee) * sellRate, want * 1e9 + 3e18, "exact-out sell share of gross");
    }

    /// Native HYPE in the manager that is not this test pool's: the genesis
    /// pool holds none (no trades) so this is just the PM's protocol fees.
    function _otherPoolsHype() internal view returns (uint256) {
        return manager.protocolFeesAccrued(CurrencyLibrary.ADDRESS_ZERO);
    }

    /// Exact-output sell asking for more than the pool can pay reverts
    /// PartialFill rather than charging on the requested amount.
    function test_exactOutSellBeyondPoolHypeIsPartialFill() public {
        vm.prank(alice);
        (address tok, PoolKey memory k) = hook.launch(params(100, 100, 0, 0, 10_000));
        swap(alice, k, sp(true, -10 ether), 10 ether); // the pool now holds 9.9 HYPE
        deal(tok, alice, SUPPLY);
        vm.startPrank(alice);
        MesaToken(tok).approve(address(swapRouter), type(uint256).max);
        (bool ok, bytes memory err) =
            address(swapRouter).call(abi.encodeCall(PoolSwapTest.swap, (k, sp(false, int256(9.9 ether)), settings, "")));
        vm.stopPrank();
        assertFalse(ok);
        assertGt(err.length, 4);
    }

    // ---------------------------------------------------------------- (1)
    /// Mixed swap kinds over two pools inside one unlock charge exactly what
    /// the same swaps charge one per transaction: T_FEE does not leak.
    function test_mixedSwapsInOneUnlockMatchSeparateOnes() public {
        vm.startPrank(alice);
        (address ta, PoolKey memory ka) = hook.launch(params(300, 700, 0, 0, 10_000));
        (address tb, PoolKey memory kb) = hook.launch(params(1_000, 100, 0, 0, 10_000));
        vm.stopPrank();
        BatchSwapper s = new BatchSwapper(manager);
        vm.deal(address(s), 1_000 ether);
        // Seed the swapper with tokens and the pools with HYPE.
        swap(bob, ka, sp(true, -50 ether), 50 ether);
        swap(bob, kb, sp(true, -50 ether), 50 ether);
        deal(ta, address(s), SUPPLY / 10);
        deal(tb, address(s), SUPPLY / 10);

        BatchSwapper.Op[] memory ops = new BatchSwapper.Op[](6);
        ops[0] = BatchSwapper.Op(ka, sp(true, -3 ether)); // exact-in buy, fee in before
        ops[1] = BatchSwapper.Op(kb, sp(false, int256(2 ether))); // exact-out sell, fee in before
        ops[2] = BatchSwapper.Op(ka, sp(false, int256(1 ether))); // exact-out sell, same pool
        ops[3] = BatchSwapper.Op(kb, sp(true, int256(1_000_000e18))); // exact-out buy, fee in after
        ops[4] = BatchSwapper.Op(ka, sp(false, -int256(5_000_000e18))); // exact-in sell, fee in after
        ops[5] = BatchSwapper.Op(kb, sp(true, -1 ether)); // exact-in buy

        uint256 snap = vm.snapshotState();
        uint256 c0 = claims();
        s.run(ops);
        uint256 batched = claims() - c0;

        vm.revertToState(snap);
        c0 = claims();
        for (uint256 i; i < ops.length; ++i) {
            BatchSwapper.Op[] memory one = new BatchSwapper.Op[](1);
            one[0] = ops[i];
            s.run(one);
        }
        assertEq(batched, claims() - c0, "same fees batched or not");
        assertEq(claims(), hook.accrued(feeTo) + hook.accrued(address(burner)), "solvent");
    }

    // ---------------------------------------------------------------- M-2
    /// Documents a known limit: the cap is per transaction, so separate
    /// transactions (even in one block) each get their own allowance.
    function test_capIsPerTransactionNotPerBlock() public {
        vm.prank(alice);
        (address tok, PoolKey memory k) = hook.launch(params(100, 100, 0, 60, 100)); // 1% per tx
        for (uint256 i; i < 5; ++i) {
            swap(i % 2 == 0 ? alice : bob, k, sp(true, -0.25 ether), 0.25 ether); // ~0.8% each, under the 1% cap
        }
        uint256 bought = MesaToken(tok).balanceOf(alice) + MesaToken(tok).balanceOf(bob);
        emit log_named_decimal_uint("bought / cap, same block", bought * 100 / SUPPLY, 0);
        assertGt(bought, 3 * SUPPLY / 100, "separate transactions together exceed the per-transaction cap");
    }
}
