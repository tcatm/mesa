// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Elysium's official bridge contracts on HyperEVM (Arbitrum Orbit).
interface IInbox {
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);
}

interface IOutbox {
    function executeTransaction(
        bytes32[] calldata proof,
        uint256 index,
        address l2Sender,
        address to,
        uint256 l2Block,
        uint256 l1Block,
        uint256 l2Timestamp,
        uint256 value,
        bytes calldata data
    ) external;
}

/// @title MesaBridge
/// @notice HYPE in and out of Elysium, on HyperEVM, through Elysium's official
/// bridge. A thin front door: each call goes straight to the official Inbox or
/// Outbox in the same transaction, so explorers show "Bridge" and "Claim".
///
/// Holds nothing, has no owner and cannot be changed. If Elysium's Outbox is
/// ever replaced, claims go to the new one directly (anyone may claim).
contract MesaBridge {
    IInbox public immutable inbox;
    IOutbox public immutable outbox;

    error FeeAboveValue();
    error ZeroRecipient();

    constructor(IInbox inbox_, IOutbox outbox_) {
        inbox = inbox_;
        outbox = outbox_;
    }

    /// @notice Bridge HYPE to `to` on Elysium, 1:1. `msg.value` is the amount
    /// plus the bridge gas deposit (`maxSubmissionCost + gasLimit * maxFeePerGas`),
    /// whose unused part is refunded to `to` on Elysium.
    /// @return The deposit's message number in Elysium's inbox.
    function bridge(address to, uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas)
        external
        payable
        returns (uint256)
    {
        if (to == address(0)) revert ZeroRecipient();
        uint256 fee = maxSubmissionCost + gasLimit * maxFeePerGas;
        if (fee > msg.value) revert FeeAboveValue();
        return inbox.createRetryableTicket{value: msg.value}(
            to, msg.value - fee, maxSubmissionCost, to, to, gasLimit, maxFeePerGas, ""
        );
    }

    /// @notice Claim a confirmed withdrawal from Elysium. Pays its recipient,
    /// whoever sends this; the arguments are those of `Outbox.executeTransaction`.
    function claim(
        bytes32[] calldata proof,
        uint256 index,
        address l2Sender,
        address to,
        uint256 l2Block,
        uint256 l1Block,
        uint256 l2Timestamp,
        uint256 value,
        bytes calldata data
    ) external {
        outbox.executeTransaction(proof, index, l2Sender, to, l2Block, l1Block, l2Timestamp, value, data);
    }
}
