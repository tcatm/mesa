// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {MesaBridge, IInbox, IOutbox} from "../src/MesaBridge.sol";
import {MesaWithdraw} from "../src/MesaWithdraw.sol";

contract InboxMock {
    struct Ticket {
        address to;
        uint256 l2CallValue;
        uint256 maxSubmissionCost;
        address excessFeeRefundAddress;
        address callValueRefundAddress;
        uint256 gasLimit;
        uint256 maxFeePerGas;
        bytes data;
        uint256 value;
    }

    Ticket public last;

    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256) {
        require(msg.value == maxSubmissionCost + l2CallValue + gasLimit * maxFeePerGas, "value");
        last = Ticket(
            to,
            l2CallValue,
            maxSubmissionCost,
            excessFeeRefundAddress,
            callValueRefundAddress,
            gasLimit,
            maxFeePerGas,
            data,
            msg.value
        );
        return 42;
    }
}

contract OutboxMock {
    bytes public lastCall;

    function executeTransaction(
        bytes32[] calldata,
        uint256,
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        bytes calldata
    ) external {
        lastCall = msg.data;
    }
}

contract ArbSysMock {
    address public lastTo;
    uint256 public lastValue;

    function withdrawEth(address to) external payable returns (uint256) {
        lastTo = to;
        lastValue = msg.value;
        return 7;
    }
}

contract MesaBridgeTest is Test {
    InboxMock inbox = new InboxMock();
    OutboxMock outbox = new OutboxMock();
    MesaBridge b = new MesaBridge(IInbox(address(inbox)), IOutbox(address(outbox)));
    address alice = makeAddr("alice");

    function test_bridgeForwardsEverything() public {
        uint256 sub = 1e12;
        uint256 gasLimit = 300_000;
        uint256 price = 1 gwei;
        uint256 fee = sub + gasLimit * price;
        vm.deal(address(this), 1 ether);
        uint256 n = b.bridge{value: 0.05 ether + fee}(alice, sub, gasLimit, price);
        assertEq(n, 42);
        (
            address to,
            uint256 l2CallValue,
            uint256 maxSub,
            address refund1,
            address refund2,
            uint256 gl,
            uint256 mfpg,
            bytes memory data,
            uint256 value
        ) = inbox.last();
        assertEq(to, alice);
        assertEq(l2CallValue, 0.05 ether);
        assertEq(maxSub, sub);
        assertEq(refund1, alice);
        assertEq(refund2, alice);
        assertEq(gl, gasLimit);
        assertEq(mfpg, price);
        assertEq(data.length, 0);
        assertEq(value, 0.05 ether + fee);
        assertEq(address(b).balance, 0);
    }

    function testFuzz_bridgeHoldsNothing(uint96 amount, uint64 sub, uint32 gasLimit, uint40 price) public {
        uint256 fee = uint256(sub) + uint256(gasLimit) * price;
        uint256 value = uint256(amount) + fee;
        vm.deal(address(this), value);
        b.bridge{value: value}(alice, sub, gasLimit, price);
        (, uint256 l2CallValue,,,,,,,) = inbox.last();
        assertEq(l2CallValue, amount);
        assertEq(address(b).balance, 0);
    }

    function test_bridgeRejectsFeeAboveValue() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(MesaBridge.FeeAboveValue.selector);
        b.bridge{value: 1}(alice, 2, 0, 0);
    }

    function test_bridgeRejectsZeroRecipient() public {
        vm.expectRevert(MesaBridge.ZeroRecipient.selector);
        b.bridge(address(0), 0, 0, 0);
    }

    function test_claimForwardsCalldata() public {
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = bytes32(uint256(1));
        proof[1] = bytes32(uint256(2));
        b.claim(proof, 5, alice, alice, 10, 20, 30, 0.05 ether, "");
        bytes memory expected =
            abi.encodeCall(IOutbox.executeTransaction, (proof, 5, alice, alice, 10, 20, 30, 0.05 ether, bytes("")));
        assertEq(outbox.lastCall(), expected);
    }

    function test_selectorsReadAsLabels() public pure {
        // Explorers name a call after its function: these show as "Bridge", "Claim" and "Withdraw".
        assertEq(MesaBridge.bridge.selector, bytes4(keccak256("bridge(address,uint256,uint256,uint256)")));
        assertEq(MesaWithdraw.withdraw.selector, bytes4(keccak256("withdraw(address)")));
    }
}

contract MesaWithdrawTest is Test {
    MesaWithdraw w = new MesaWithdraw();
    address alice = makeAddr("alice");

    function setUp() public {
        vm.etch(address(0x64), address(new ArbSysMock()).code);
    }

    function test_withdrawForwards() public {
        vm.deal(address(this), 1 ether);
        assertEq(w.withdraw{value: 0.3 ether}(alice), 7);
        assertEq(ArbSysMock(address(0x64)).lastTo(), alice);
        assertEq(ArbSysMock(address(0x64)).lastValue(), 0.3 ether);
        assertEq(address(w).balance, 0);
    }

    function test_withdrawRejects() public {
        vm.expectRevert(MesaWithdraw.ZeroAmount.selector);
        w.withdraw(alice);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(MesaWithdraw.ZeroRecipient.selector);
        w.withdraw{value: 1}(address(0));
    }
}
