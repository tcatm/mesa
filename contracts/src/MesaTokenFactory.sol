// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MesaToken} from "./MesaToken.sol";
import {MesaRewardToken} from "./MesaRewardToken.sol";
import {MesaPayout} from "./MesaPayout.sol";

/// @title MesaTokenFactory
/// @notice Makes the token of each Mesa launch, and its payout contract when
/// the creator splits their fees. Called by MesaHook during `launch`; the
/// whole supply is minted to the caller. Anyone can call it, but only tokens
/// MesaHook launches have a Mesa pool.
///
/// `payout` is empty for a plain token whose creator fees go to one wallet.
/// Otherwise it is `abi.encode(address[] recipients, uint16[] recipientBps,
/// uint16 holdersBps, uint16 buybackBps)`, shares of the creator fees adding
/// up to 10,000. A holders share makes the token a MesaRewardToken. Split
/// payouts are only for tokens paired with native HYPE.
contract MesaTokenFactory {
    error SplitNeedsHype();

    event Created(address indexed token, address indexed feeRecipient, bool rewards);

    function create(
        string calldata name,
        string calldata symbol,
        address quote,
        address feeRecipient,
        bytes calldata payout
    ) external returns (address token, address recipient) {
        if (payout.length == 0) {
            token = address(new MesaToken(name, symbol, msg.sender));
            emit Created(token, feeRecipient, false);
            return (token, feeRecipient);
        }
        if (quote != address(0)) revert SplitNeedsHype();
        (address[] memory recipients, uint16[] memory bps, uint16 holdersBps, uint16 buybackBps) =
            abi.decode(payout, (address[], uint16[], uint16, uint16));
        token = holdersBps > 0
            ? address(new MesaRewardToken(name, symbol, msg.sender))
            : address(new MesaToken(name, symbol, msg.sender));
        recipient = address(new MesaPayout(msg.sender, token, recipients, bps, holdersBps, buybackBps));
        emit Created(token, recipient, holdersBps > 0);
    }
}
