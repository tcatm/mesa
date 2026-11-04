// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IArbSys {
    function withdrawEth(address destination) external payable returns (uint256);
}

/// @title MesaWithdraw
/// @notice HYPE out of Elysium, on Elysium, through the chain's own ArbSys
/// precompile. A thin front door so explorers show "Withdraw": the HYPE goes
/// straight to ArbSys in the same transaction and becomes claimable for `to`
/// on HyperEVM after the challenge period, exactly as a direct withdrawal.
///
/// Holds nothing, has no owner and cannot be changed.
contract MesaWithdraw {
    IArbSys public constant ARB_SYS = IArbSys(0x0000000000000000000000000000000000000064);

    error ZeroRecipient();
    error ZeroAmount();

    /// @notice Withdraw `msg.value` HYPE to `to` on HyperEVM.
    /// @return The withdrawal's position in Elysium's outbox.
    function withdraw(address to) external payable returns (uint256) {
        if (to == address(0)) revert ZeroRecipient();
        if (msg.value == 0) revert ZeroAmount();
        return ARB_SYS.withdrawEth{value: msg.value}(to);
    }
}
