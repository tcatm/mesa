// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {MesaHook} from "../src/MesaHook.sol";
import {MesaToken} from "../src/MesaToken.sol";
import {BuybackBurner} from "../src/BuybackBurner.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {LaunchMath} from "../src/LaunchMath.sol";

/// ERC-20 quote assets: the registry's gating and delay, launches and every
/// swap kind with the quote on either side of the pool, dev buys, claims in
/// the quote, and the burner converting quote fees to HYPE for buybacks.
contract QuoteAssetsTest is Test, Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    int24 constant INITIAL_TICK = 173_200;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    /// Below any launched token's address: the quote is currency0.
    address constant LOW = address(0x10000);
    /// Above any launched token's address: the quote is currency1.
    address constant HIGH = address(type(uint160).max - 0xffff);

    MesaHook hook;
    BuybackBurner burner;
    QuoteRegistry registry;
    address genesis = makeAddr("genesis");
    address admin = makeAddr("admin");
    address keeper = makeAddr("keeper");
    address creator = makeAddr("creator");
    address feeTo = makeAddr("feeTo");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    PoolSwapTest.TestSettings settings = PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false});

    function setUp() public {
        deployFreshManagerAndRouters();
        address at = address(FLAGS | (uint160(0x4444) << 144));
        deployCodeTo(
            "out/MesaHook.sol/MesaHook.json",
            abi.encode(manager, uint16(7_000), INITIAL_TICK, genesis, makeAddr("owner"), keeper, 10 ether, admin),
            at
        );
        hook = MesaHook(at);
        burner = BuybackBurner(payable(hook.protocolRecipient()));
        registry = hook.quoteRegistry();
        vm.prank(genesis);
        hook.launch(params());

        for (uint256 i; i < 2; ++i) {
            address q = i == 0 ? LOW : HIGH;
            deployCodeTo("out/MockERC20.sol/MockERC20.json", abi.encode("Quote", "Q", uint8(18)), q);
            for (uint256 j; j < 4; ++j) {
                address who = [creator, alice, bob, address(this)][j];
                MockERC20(q).mint(who, 1e30);
                vm.startPrank(who);
                MockERC20(q).approve(address(hook), type(uint256).max);
                MockERC20(q).approve(address(swapRouter), type(uint256).max);
                MockERC20(q).approve(address(modifyLiquidityRouter), type(uint256).max);
                vm.stopPrank();
            }
        }
        vm.deal(address(this), 1e30);
        vm.deal(alice, 1e30);
    }

    // ---------------------------------------------------------------- helpers

    function params() internal view returns (MesaHook.LaunchParams memory) {
        return MesaHook.LaunchParams("Token", "TKN", "", feeTo, 100, 100, 0, 0, 10_000);
    }

    /// A plain HYPE/quote pool at 1:1 with deep liquidity, for conversions.
    function routeFor(address q) internal returns (PoolKey memory route) {
        route = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(q), 3_000, 60, IHooks(address(0)));
        manager.initialize(route, TickMath.getSqrtPriceAtTick(0));
        modifyLiquidityRouter.modifyLiquidity{value: 2_000e18}(
            route, IPoolManager.ModifyLiquidityParams(-887_220, 887_220, 1_000e18, 0), ""
        );
    }

    function enable(address q) internal {
        PoolKey memory route = routeFor(q);
        vm.prank(admin);
        registry.propose(q, INITIAL_TICK, route);
        vm.warp(block.timestamp + 3 days);
        registry.activate(q);
    }

    function launchOn(address q, uint256 devBuy) internal returns (MesaToken t, PoolKey memory k) {
        vm.prank(creator);
        (address a, PoolKey memory key) = hook.launchWithQuote(params(), q, devBuy);
        (t, k) = (MesaToken(a), key);
    }

    function quoteIs0(PoolKey memory k, address q) internal pure returns (bool) {
        return Currency.unwrap(k.currency0) == q;
    }

    function swap(address who, PoolKey memory k, address q, bool buy, int256 amt) internal {
        bool z = buy == quoteIs0(k, q);
        if (!buy) {
            address token = Currency.unwrap(quoteIs0(k, q) ? k.currency1 : k.currency0);
            vm.prank(who);
            MesaToken(token).approve(address(swapRouter), type(uint256).max);
        }
        vm.prank(who);
        swapRouter.swap(
            k,
            IPoolManager.SwapParams(z, amt, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            settings,
            ""
        );
    }

    function assertSolvent(address q) internal view {
        assertEq(
            manager.balanceOf(address(hook), uint160(q)),
            hook.accruedOf(q, feeTo) + hook.accruedOf(q, address(burner)),
            "hook claims != accrued"
        );
    }

    // ---------------------------------------------------------------- registry

    function test_quoteNeedsProposalDelayAndActivation() public {
        vm.expectRevert(QuoteRegistry.NotAllowed.selector);
        launchOn(LOW, 0);

        PoolKey memory route = routeFor(LOW);
        vm.expectRevert(QuoteRegistry.NotAdmin.selector);
        registry.propose(LOW, INITIAL_TICK, route);

        vm.prank(admin);
        registry.propose(LOW, INITIAL_TICK, route);
        vm.expectRevert(QuoteRegistry.NotReady.selector);
        registry.activate(LOW);
        vm.warp(block.timestamp + 3 days - 1);
        vm.expectRevert(QuoteRegistry.NotReady.selector);
        registry.activate(LOW);
        vm.expectRevert(QuoteRegistry.NotAllowed.selector);
        launchOn(LOW, 0);

        vm.warp(block.timestamp + 1);
        registry.activate(LOW); // anyone can
        launchOn(LOW, 0);
    }

    function test_disableStopsNewLaunchesOnly() public {
        enable(LOW);
        (MesaToken t, PoolKey memory k) = launchOn(LOW, 0);
        vm.prank(admin);
        registry.disable(LOW);
        vm.expectRevert(QuoteRegistry.NotAllowed.selector);
        launchOn(LOW, 0);
        // The existing pool trades, and its fees can be claimed.
        swap(alice, k, LOW, true, -1 ether);
        swap(alice, k, LOW, false, -int256(t.balanceOf(alice)));
        vm.prank(feeTo);
        hook.claim(LOW);
        assertGt(MockERC20(LOW).balanceOf(feeTo), 0);
    }

    function test_cancelAndRejectedProposals() public {
        PoolKey memory route = routeFor(LOW);
        vm.startPrank(admin);
        registry.propose(LOW, INITIAL_TICK, route);
        registry.cancel(LOW);
        vm.expectRevert(QuoteRegistry.NotReady.selector);
        registry.cancel(LOW);

        // Native HYPE is not listed; quotes must be contracts; ticks must fit; routes must be HYPE/quote.
        vm.expectRevert(QuoteRegistry.BadQuote.selector);
        registry.propose(address(0), INITIAL_TICK, route);
        vm.expectRevert(QuoteRegistry.BadQuote.selector);
        registry.propose(makeAddr("eoa"), INITIAL_TICK, route);
        vm.expectRevert(LaunchMath.BadStartTick.selector);
        registry.propose(LOW, 173_201, route);
        vm.expectRevert(LaunchMath.BadStartTick.selector);
        registry.propose(LOW, -400_000, route);
        PoolKey memory wrong = route;
        wrong.currency1 = Currency.wrap(HIGH);
        vm.expectRevert(QuoteRegistry.BadRoute.selector);
        registry.propose(LOW, INITIAL_TICK, wrong);
        vm.stopPrank();

        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(QuoteRegistry.NotReady.selector);
        registry.activate(LOW);
    }

    function test_adminHandoverAndRenounce() public {
        address next = makeAddr("next");
        vm.prank(admin);
        registry.transferAdmin(next);
        vm.expectRevert(QuoteRegistry.NotAdmin.selector);
        registry.acceptAdmin();
        vm.prank(next);
        registry.acceptAdmin();
        assertEq(registry.admin(), next);

        vm.prank(next);
        registry.renounceAdmin();
        assertEq(registry.admin(), address(0));
        PoolKey memory route = routeFor(LOW);
        vm.prank(next);
        vm.expectRevert(QuoteRegistry.NotAdmin.selector);
        registry.propose(LOW, INITIAL_TICK, route);
    }

    function test_genesisMustBeNativeHype() public {
        address at = address(FLAGS | (uint160(0x5555) << 144));
        deployCodeTo(
            "out/MesaHook.sol/MesaHook.json",
            abi.encode(manager, uint16(7_000), INITIAL_TICK, genesis, makeAddr("owner"), keeper, 10 ether, admin),
            at
        );
        MesaHook fresh = MesaHook(at);
        PoolKey memory route = routeFor(LOW);
        QuoteRegistry r = fresh.quoteRegistry();
        vm.prank(admin);
        r.propose(LOW, INITIAL_TICK, route);
        vm.warp(block.timestamp + 3 days);
        r.activate(LOW);
        vm.prank(genesis);
        vm.expectRevert(MesaHook.GenesisFirst.selector);
        fresh.launchWithQuote(params(), LOW, 0);
    }

    // ---------------------------------------------------------------- launches and swaps

    /// Both orientations: the pool opens at the quote's start tick, every swap
    /// kind pays its fee in the quote, and when everyone exits the price is
    /// back at the start with the quote conserved.
    function test_bothOrientations() public {
        for (uint256 i; i < 2; ++i) {
            address q = i == 0 ? LOW : HIGH;
            enable(q);
            (MesaToken t, PoolKey memory k) = launchOn(q, 0);
            bool q0 = quoteIs0(k, q);
            assertEq(q0, i == 0, "orientation");
            (, int24 tick,,) = manager.getSlot0(k.toId());
            assertEq(tick, q0 ? INITIAL_TICK : -INITIAL_TICK, "start tick");

            // Exact-in buy: 1% of 1 Q.
            swap(alice, k, q, true, -1 ether);
            assertEq(hook.accruedOf(q, feeTo), 0.007 ether);
            assertEq(hook.accruedOf(q, address(burner)), 0.003 ether);
            // Exact-out buy, exact-in sell, exact-out sell.
            swap(bob, k, q, true, int256(1_000_000e18));
            assertEq(t.balanceOf(bob), 1_000_000e18);
            swap(alice, k, q, false, -int256(t.balanceOf(alice) / 2));
            swap(alice, k, q, false, int256(0.1 ether));
            assertSolvent(q);

            // Everyone exits.
            swap(alice, k, q, false, -int256(t.balanceOf(alice)));
            swap(bob, k, q, false, -int256(t.balanceOf(bob)));
            assertEq(t.balanceOf(address(manager)) + t.balanceOf(hook.DEAD()), SUPPLY, "all tokens back");
            (, tick,,) = manager.getSlot0(k.toId());
            if (q0) assertGe(tick, INITIAL_TICK - 1, "price back at start");
            else assertLe(tick, -INITIAL_TICK + 1, "price back at start");
            assertSolvent(q);
            assertEq(manager.balanceOf(address(hook), 0), 0, "no HYPE fees from a quote pool");
        }
    }

    /// Random fees and sizes, quote on either side: every swap kind fills and
    /// pays exactly `rate` of the gross quote amount.
    function testFuzz_allKindsEitherSide(bool high, uint96 amount, uint16 buyFee, uint16 sellFee) public {
        address q = high ? HIGH : LOW;
        amount = uint96(bound(amount, 1e9, 30 ether));
        buyFee = uint16(bound(buyFee, 100, 1_000));
        sellFee = uint16(bound(sellFee, 100, 1_000));
        enable(q);
        MesaHook.LaunchParams memory p = params();
        (p.buyFeeBps, p.sellFeeBps) = (buyFee, sellFee);
        vm.prank(creator);
        (address a, PoolKey memory k) = hook.launchWithQuote(p, q, 0);
        MesaToken t = MesaToken(a);

        uint256 bal = MockERC20(q).balanceOf(alice);
        uint256 fees = manager.balanceOf(address(hook), uint160(q));
        swap(alice, k, q, true, -int256(uint256(amount))); // exact-in buy
        assertEq(bal - MockERC20(q).balanceOf(alice), amount);
        assertEq(manager.balanceOf(address(hook), uint160(q)) - fees, uint256(amount) * buyFee / 10_000);

        uint256 want = t.balanceOf(alice) / 3;
        bal = MockERC20(q).balanceOf(bob);
        fees = manager.balanceOf(address(hook), uint160(q));
        swap(bob, k, q, true, int256(want)); // exact-out buy
        assertEq(t.balanceOf(bob), want);
        uint256 paid = bal - MockERC20(q).balanceOf(bob);
        assertApproxEqAbs(manager.balanceOf(address(hook), uint160(q)) - fees, paid * buyFee / 10_000, 2);

        bal = MockERC20(q).balanceOf(alice);
        uint256 out = amount / 10;
        swap(alice, k, q, false, int256(out)); // exact-out sell, while the pool holds plenty
        assertEq(MockERC20(q).balanceOf(alice) - bal, out);

        bal = MockERC20(q).balanceOf(alice);
        fees = manager.balanceOf(address(hook), uint160(q));
        swap(alice, k, q, false, -int256(t.balanceOf(alice))); // exact-in sell
        uint256 got = MockERC20(q).balanceOf(alice) - bal;
        uint256 fee = manager.balanceOf(address(hook), uint160(q)) - fees;
        assertApproxEqAbs(fee, (got + fee) * sellFee / 10_000, 2);
        assertSolvent(q);
    }

    function test_devBuyInQuote() public {
        for (uint256 i; i < 2; ++i) {
            address q = i == 0 ? LOW : HIGH;
            enable(q);
            uint256 before = MockERC20(q).balanceOf(creator);
            (MesaToken t,) = launchOn(q, 2 ether);
            assertGt(t.balanceOf(creator), 0);
            assertEq(before - MockERC20(q).balanceOf(creator), 2 ether);
            assertEq(hook.accruedOf(q, feeTo), 0.014 ether, "1% fee on the dev buy, 70% to creator");
            assertSolvent(q);
        }
        // A dev buy over 10% of supply reverts, in either orientation.
        vm.expectRevert();
        launchOn(LOW, 100 ether);
        vm.expectRevert();
        launchOn(HIGH, 100 ether);
        // Native HYPE is not accepted for an ERC-20 launch.
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(MesaHook.InvalidParams.selector, "msg.value"));
        hook.launchWithQuote{value: 1 ether}(params(), LOW, 1 ether);
    }

    function test_snipeCapAppliesInQuotePools() public {
        enable(HIGH);
        MesaHook.LaunchParams memory p = params();
        p.snipeSeconds = 60;
        p.maxBuyBps = 100; // 1% of supply per transaction
        vm.prank(creator);
        (, PoolKey memory k) = hook.launchWithQuote(p, HIGH, 0);
        vm.expectRevert();
        swap(alice, k, HIGH, true, int256(SUPPLY / 50));
        swap(alice, k, HIGH, true, int256(SUPPLY / 200));
    }

    function test_previewMatchesFees() public {
        enable(HIGH);
        (MesaToken t,) = launchOn(HIGH, 0);
        (uint256 base, uint256 sniper, uint256 toCreator, uint256 toProtocol) =
            hook.previewFees(address(t), 1 ether, true);
        assertEq(base, 0.01 ether);
        assertEq(sniper, 0);
        swap(alice, hook.poolKeyOf(address(t)), HIGH, true, -1 ether);
        assertEq(hook.accruedOf(HIGH, feeTo), toCreator);
        assertEq(hook.accruedOf(HIGH, address(burner)), toProtocol);
    }

    // ---------------------------------------------------------------- buyback

    function test_burnerConvertsQuoteFeesAndBurnsMesa() public {
        enable(LOW);
        (MesaToken t, PoolKey memory k) = launchOn(LOW, 0);
        for (uint256 i; i < 5; ++i) {
            swap(alice, k, LOW, true, -50 ether);
            swap(alice, k, LOW, false, -int256(t.balanceOf(alice)));
        }
        uint256 owed = hook.accruedOf(LOW, address(burner));
        assertGt(owed, 0);
        burner.collect(LOW);
        assertEq(MockERC20(LOW).balanceOf(address(burner)), owed);

        vm.expectRevert(BuybackBurner.NotKeeper.selector);
        burner.convert(LOW, owed, 0);
        vm.prank(keeper);
        vm.expectRevert();
        burner.convert(LOW, owed, owed); // 1:1 is impossible after the route's fee
        vm.prank(keeper);
        uint256 hype = burner.convert(LOW, owed, 0);
        assertGt(hype, 0);
        assertEq(address(burner).balance, hype);
        assertEq(MockERC20(LOW).balanceOf(address(burner)), 0);

        MesaToken mesa = MesaToken(hook.genesisToken());
        vm.prank(keeper);
        burner.buyback(hype, 1);
        assertGt(mesa.balanceOf(burner.DEAD()), 0);
        assertEq(address(burner).balance, 0);
    }

    function test_noRouteForUnlistedQuote() public {
        MockERC20(HIGH).mint(address(burner), 1 ether);
        vm.prank(keeper);
        vm.expectRevert();
        burner.convert(HIGH, 1 ether, 0);
    }
}
