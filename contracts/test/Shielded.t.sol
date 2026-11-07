// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool, IWithdrawVerifier} from "../src/ShieldedPool.sol";
import {WithdrawVerifier} from "../src/WithdrawVerifier.sol";
import {PoseidonT3} from "../src/PoseidonT3.sol";

/// Shared setup. The deployment order (nonce 1 verifier, 2 pool; the perps tests
/// add 3 oracle, 4 market) is the one shielded/scripts/fixtures.mjs assumes: the
/// fixture proofs are bound to these addresses.
abstract contract ShieldedBase is Test {
    WithdrawVerifier verifier;
    ShieldedPool pool;
    string fx;

    address constant GUARDIAN = address(0x6A);
    address constant RECIPIENT = 0x1111111111111111111111111111111111111111;
    address constant RELAYER = 0x2222222222222222222222222222222222222222;
    address constant RECIPIENT2 = 0x3333333333333333333333333333333333333333;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        fx = vm.readFile("test/fixtures/shielded.json");
        verifier = new WithdrawVerifier();
        pool = new ShieldedPool(IWithdrawVerifier(address(verifier)), 10 ether, 100 ether, GUARDIAN);
        assertEq(address(pool), vm.parseJsonAddress(fx, ".pool"), "pool address moved: rerun fixtures.mjs");
    }

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(fx, key);
    }

    function _depositAll() internal {
        for (uint256 i = 0; i < 3; i++) {
            string memory k = string.concat(".deposits[", vm.toString(i), "]");
            uint256 value = _u(string.concat(k, ".value"));
            vm.deal(address(this), address(this).balance + value);
            uint32 index = pool.deposit{value: value}(_u(string.concat(k, ".precommitment")));
            assertEq(index, i);
        }
    }

    function _w(string memory k) internal view returns (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) {
        w = ShieldedPool.Withdrawal({
            root: _u(string.concat(k, ".root")),
            nullifierHash: _u(string.concat(k, ".nullifierHash")),
            withdrawn: _u(string.concat(k, ".withdrawn")),
            newLeaf: _u(string.concat(k, ".newLeaf")),
            recipient: vm.parseJsonAddress(fx, string.concat(k, ".recipient")),
            relayer: vm.parseJsonAddress(fx, string.concat(k, ".relayer")),
            fee: _u(string.concat(k, ".fee")),
            data: vm.parseJsonBytes(fx, string.concat(k, ".data"))
        });
        uint256[] memory p = vm.parseJsonUintArray(fx, string.concat(k, ".proof"));
        for (uint256 i = 0; i < 8; i++) {
            proof[i] = p[i];
        }
    }
}

contract ShieldedPoolTest is ShieldedBase {
    function test_poseidonMatchesCircomlib() public pure {
        assertEq(
            PoseidonT3.hash([uint256(1), 2]),
            7853200120776062878684798364095072458815029376092732009249414926327459813530
        );
    }

    function test_emptyTreeMatchesOffChainTree() public view {
        assertEq(pool.getLastRoot(), _u(".emptyRoot"));
    }

    function test_depositsBuildTheSameTree() public {
        _depositAll();
        assertEq(pool.getLastRoot(), _u(".rootAfterDeposits"));
        assertEq(pool.nextIndex(), 3);
        assertEq(address(pool).balance, 8 ether);
    }

    function test_partialWithdrawThroughRelayer() public {
        _depositAll();
        (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) = _w(".w1");
        vm.prank(RELAYER);
        pool.withdraw(w, proof);
        assertEq(RECIPIENT.balance, 0.39 ether);
        assertEq(RELAYER.balance, 0.01 ether);
        assertTrue(pool.spent(w.nullifierHash));
        // The 0.6 HYPE change note is now leaf 3.
        assertEq(pool.nextIndex(), 4);
        assertEq(pool.getLastRoot(), _u(".w1.rootAfter"));
        assertEq(address(pool).balance, 7.6 ether);
    }

    function test_changeNoteSpendsLater() public {
        _depositAll();
        (ShieldedPool.Withdrawal memory w1, uint256[8] memory p1) = _w(".w1");
        pool.withdraw(w1, p1);
        (ShieldedPool.Withdrawal memory w2, uint256[8] memory p2) = _w(".w2");
        assertEq(w2.newLeaf, 0, "nothing left, no change note");
        pool.withdraw(w2, p2);
        assertEq(RECIPIENT2.balance, 0.6 ether);
        assertEq(pool.nextIndex(), 4);
    }

    function test_noteSpendsOnce() public {
        _depositAll();
        (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) = _w(".w1");
        pool.withdraw(w, proof);
        vm.expectRevert(ShieldedPool.AlreadySpent.selector);
        pool.withdraw(w, proof);
    }

    function test_proofIsBoundToItsTerms() public {
        _depositAll();
        (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) = _w(".w1");

        ShieldedPool.Withdrawal memory t = _copy(w);
        t.recipient = address(0xBAD);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(t, proof);

        t = _copy(w);
        t.fee = 0.2 ether;
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(t, proof);

        t = _copy(w);
        t.relayer = address(0xBAD);
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(t, proof);

        t = _copy(w);
        t.withdrawn = 1 ether;
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(t, proof);

        t = _copy(w);
        t.newLeaf = 12345;
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(t, proof);

        t = _copy(w);
        t.data = hex"01";
        vm.expectRevert(ShieldedPool.InvalidProof.selector);
        pool.withdraw(t, proof);

        // Untouched, it goes through.
        pool.withdraw(w, proof);
    }

    function test_unknownRootIsRefused() public {
        _depositAll();
        (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) = _w(".w1");
        w.root = 1;
        vm.expectRevert(ShieldedPool.UnknownRoot.selector);
        pool.withdraw(w, proof);
    }

    function test_proofsSurviveLaterDeposits() public {
        _depositAll();
        (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) = _w(".w1");
        for (uint256 i = 0; i < 10; i++) {
            pool.deposit{value: 1}(i + 1);
        }
        pool.withdraw(w, proof);
        assertEq(RECIPIENT.balance, 0.39 ether);
    }

    function test_depositLimits() public {
        vm.deal(address(this), 1_000 ether);
        vm.expectRevert(ShieldedPool.ZeroValue.selector);
        pool.deposit(1);
        vm.expectRevert(ShieldedPool.DepositTooLarge.selector);
        pool.deposit{value: 10 ether + 1}(1);
        uint256 field = pool.FIELD();
        vm.expectRevert(ShieldedPool.NotInField.selector);
        pool.deposit{value: 1}(field);
        for (uint256 i = 0; i < 10; i++) {
            pool.deposit{value: 10 ether}(i + 1);
        }
        vm.expectRevert(ShieldedPool.CapReached.selector);
        pool.deposit{value: 1}(99);
    }

    function test_guardianPausesDepositsOnly() public {
        _depositAll();
        vm.expectRevert(ShieldedPool.NotGuardian.selector);
        pool.setDepositsPaused(true);
        vm.prank(GUARDIAN);
        pool.setDepositsPaused(true);
        vm.expectRevert(ShieldedPool.Paused.selector);
        pool.deposit{value: 1 ether}(7);
        // Withdrawals keep working while deposits are paused.
        (ShieldedPool.Withdrawal memory w, uint256[8] memory proof) = _w(".w1");
        pool.withdraw(w, proof);
        assertEq(RECIPIENT.balance, 0.39 ether);
    }

    function _copy(ShieldedPool.Withdrawal memory w) internal pure returns (ShieldedPool.Withdrawal memory) {
        return
            ShieldedPool.Withdrawal(
                w.root, w.nullifierHash, w.withdrawn, w.newLeaf, w.recipient, w.relayer, w.fee, w.data
            );
    }

    receive() external payable {}
}
