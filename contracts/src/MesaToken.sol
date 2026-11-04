// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @title MesaToken
/// @notice A token launched on Mesa. Fixed supply, minted once at creation to
/// the launcher, which puts all of it into the token's locked pool. There is
/// no owner, no mint, no burn, no pause and no transfer tax.
contract MesaToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    constructor(string memory name_, string memory symbol_, address recipient) ERC20(name_, symbol_, 18) {
        _mint(recipient, TOTAL_SUPPLY);
    }
}
