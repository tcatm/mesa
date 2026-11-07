// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ShieldedPool} from "../src/ShieldedPool.sol";
import {PerpMarket, IPriceOracle} from "../src/PerpMarket.sol";
import {ShieldedBase} from "./Shielded.t.sol";

contract MockOracle is IPriceOracle {
    uint256 public price;
    uint256 public updatedAt;

    function set(uint256 p) external {
        price = p;
        updatedAt = block.timestamp;
    }

    function latest() external view returns (uint256, uint256) {
        return (price, updatedAt);
    }
}

contract PerpMarketTest is ShieldedBase {
    address constant LP = address(0x1B);
    address constant TRADER = address(0x7A);
    address constant KEEPER = address(0x4E);

    MockOracle oracle;
    PerpMarket market;
    uint256 constant OWNER_KEY = 0xa11ce;

    function setUp() public override {
        super.setUp();
        oracle = new MockOracle();
        market = new PerpMarket(
            PerpMarket.Config({
                oracle: oracle,
                shieldedPool: address(pool),
                maxPriceAge: 1 hours,
                maxLeverage: 20,
                maintenanceBps: 250,
                tradeFeeBps: 5,
                liquidationFeeBps: 1_000,
                oiCapBps: 5_000,
                fundingRatePerSecond: uint256(0.1e18) / 1 days
            })
        );
        assertEq(address(market), vm.parseJsonAddress(fx, ".market"), "market address moved: rerun fixtures.mjs");
        oracle.set(100 ether);
        vm.deal(LP, 1_000 ether);
        vm.prank(LP);
        market.addLiquidity{value: 200 ether}();
        vm.deal(TRADER, 100 ether);
    }

    // ---------------------------------------------------------- shielded

    function _openShielded() internal returns (uint256 id) {
        _depositAll();
        // The fixture's proof for w3 is against the tree after w1's change note.
        (ShieldedPool.Withdrawal memory w1, uint256[8] memory p1) = _w(".w1");
        pool.withdraw(w1, p1);
        (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) = _w(".w3");
        vm.prank(RELAYER);
        pool.withdraw(w, proof);
        id = 1;
    }

    function test_opensFromTheShieldedPool() public {
        uint256 id = _openShielded();
        (address owner, bool isLong, uint256 size, uint256 margin, uint256 entry,) = market.positions(id);
        assertEq(owner, vm.addr(OWNER_KEY));
        assertEq(owner, vm.parseJsonAddress(fx, ".owner"));
        assertTrue(isLong);
        assertEq(size, 0.5 ether);
        assertEq(entry, 100 ether);
        // 2.999 HYPE arrived; 0.05% of the 50 HYPE notional is the fee.
        assertEq(margin, 2.999 ether - 0.025 ether);
        assertEq(RELAYER.balance, 0.01 ether + 0.001 ether);
        // 2 HYPE stayed shielded as change.
        assertEq(pool.nextIndex(), 5);
        assertEq(owner.balance, 0, "the key never held HYPE");
    }

    function test_onlyThePoolOpensShielded() public {
        vm.expectRevert(PerpMarket.NotPool.selector);
        market.onShieldedWithdraw{value: 1 ether}(abi.encode(TRADER, true, 0.1 ether, 101 ether));
    }

    function test_closesBySignatureIntoANewNote() public {
        uint256 id = _openShielded();
        oracle.set(110 ether);
        uint256 pre = _u(".reshield.precommitment");
        PerpMarket.Payout memory payout = PerpMarket.Payout(address(0), pre);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signClose(id, 109 ether, payout, RELAYER, 0.002 ether, deadline);

        uint256 poolBefore = address(pool).balance;
        uint256 leavesBefore = pool.nextIndex();
        vm.prank(RELAYER);
        market.closeWithSig(id, 109 ether, payout, RELAYER, 0.002 ether, deadline, v, r, s);

        // +10 HYPE x 0.5 = 5 HYPE profit, less the 0.0275 close fee and the relayer.
        uint256 equity = 2.974 ether + 5 ether - 0.0275 ether;
        assertEq(address(pool).balance - poolBefore, equity - 0.002 ether);
        assertEq(pool.nextIndex(), leavesBefore + 1, "proceeds are a new note");
        assertEq(RELAYER.balance, 0.01 ether + 0.001 ether + 0.002 ether);
        (address owner,,,,,) = market.positions(id);
        assertEq(owner, address(0));
    }

    function test_closeSignatureIsSingleUseAndBound() public {
        uint256 id = _openShielded();
        PerpMarket.Payout memory payout = PerpMarket.Payout(RECIPIENT, 0);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signClose(id, 99 ether, payout, RELAYER, 0, deadline);

        PerpMarket.Payout memory other = PerpMarket.Payout(address(0xBAD), 0);
        vm.expectRevert(PerpMarket.BadSignature.selector);
        market.closeWithSig(id, 99 ether, other, RELAYER, 0, deadline, v, r, s);

        vm.warp(deadline + 1);
        vm.expectRevert(PerpMarket.Expired.selector);
        market.closeWithSig(id, 99 ether, payout, RELAYER, 0, deadline, v, r, s);
    }

    // ---------------------------------------------------------- public path

    function test_openAndCloseAtALoss() public {
        vm.prank(TRADER);
        uint256 id = market.open{value: 2.0125 ether}(TRADER, false, 0.25 ether, 99 ether);
        (,,, uint256 margin,,) = market.positions(id);
        assertEq(margin, 2 ether);
        oracle.set(102 ether);
        uint256 before = TRADER.balance;
        vm.prank(TRADER);
        market.close(id, 103 ether, PerpMarket.Payout(TRADER, 0));
        // Short 0.25 from 100 to 102: -0.5 HYPE, and 0.01275 close fee.
        assertEq(TRADER.balance - before, 2 ether - 0.5 ether - 0.01275 ether);
        assertEq(market.vaultAssets(), 200 ether + 0.0125 ether + 0.5 ether + 0.01275 ether);
    }

    function test_onlyTheOwnerCloses() public {
        vm.prank(TRADER);
        uint256 id = market.open{value: 2.0125 ether}(TRADER, false, 0.25 ether, 99 ether);
        vm.expectRevert(PerpMarket.NotOwner.selector);
        market.close(id, 0, PerpMarket.Payout(address(this), 0));
    }

    function test_leverageAndOpenInterestCaps() public {
        vm.startPrank(TRADER);
        // 50 HYPE notional on 2 HYPE margin is 25x.
        vm.expectRevert(PerpMarket.TooMuchLeverage.selector);
        market.open{value: 2.025 ether}(TRADER, true, 0.5 ether, 101 ether);
        // The vault (200) caps each side at 100 HYPE notional.
        vm.expectRevert(PerpMarket.OpenInterestCap.selector);
        market.open{value: 10 ether}(TRADER, true, 1.01 ether, 101 ether);
        vm.stopPrank();
    }

    function test_slippageAndStalePrices() public {
        vm.startPrank(TRADER);
        vm.expectRevert(PerpMarket.Slippage.selector);
        market.open{value: 1 ether}(TRADER, true, 0.1 ether, 99 ether);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(PerpMarket.StalePrice.selector);
        market.open{value: 1 ether}(TRADER, true, 0.1 ether, 101 ether);
        vm.stopPrank();
    }

    function test_liquidation() public {
        vm.prank(TRADER);
        uint256 id = market.open{value: 3.025 ether}(TRADER, true, 0.5 ether, 101 ether);
        oracle.set(97 ether);
        assertFalse(market.isLiquidatable(id));
        vm.expectRevert(PerpMarket.NotLiquidatable.selector);
        market.liquidate(id);
        // At 95: equity 3 - 2.5 = 0.5 < 2.5% of 47.5 = 1.1875.
        oracle.set(95 ether);
        assertTrue(market.isLiquidatable(id));
        vm.prank(TRADER);
        vm.expectRevert(PerpMarket.Liquidatable.selector);
        market.close(id, 0, PerpMarket.Payout(TRADER, 0));
        vm.prank(KEEPER);
        market.liquidate(id);
        assertEq(KEEPER.balance, 0.05 ether, "10% of what is left");
        assertEq(address(market).balance, market.vaultAssets(), "every wei is the vault's");
    }

    function test_fundingFlowsFromTheCrowdedSide() public {
        vm.prank(TRADER);
        uint256 id = market.open{value: 3.025 ether}(TRADER, true, 0.5 ether, 101 ether);
        vm.warp(block.timestamp + 1 days);
        oracle.set(100 ether);
        // All OI is long: longs pay 10% of notional per day.
        assertApproxEqAbs(market.equityOf(id), 3 ether - 5 ether, 1e9);
        assertTrue(market.isLiquidatable(id));
    }

    function test_vaultCannotLeaveOpenInterestUncovered() public {
        vm.prank(TRADER);
        market.open{value: 5.05 ether}(TRADER, true, 0.9 ether, 101 ether);
        // 90 HYPE long needs 180 in the vault.
        vm.prank(LP);
        vm.expectRevert(PerpMarket.VaultCommitted.selector);
        market.removeLiquidity(30 ether);
        vm.prank(LP);
        market.removeLiquidity(10 ether);
    }

    function _signClose(
        uint256 id,
        uint256 acceptablePrice,
        PerpMarket.Payout memory payout,
        address relayer,
        uint256 relayerFee,
        uint256 deadline
    ) internal view returns (uint8, bytes32, bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                market.CLOSE_TYPEHASH(),
                id,
                acceptablePrice,
                payout.to,
                payout.precommitment,
                relayer,
                relayerFee,
                market.nonces(vm.addr(OWNER_KEY)),
                deadline
            )
        );
        return vm.sign(OWNER_KEY, keccak256(abi.encodePacked("\x19\x01", market.DOMAIN_SEPARATOR(), structHash)));
    }

    receive() external payable {}
}
