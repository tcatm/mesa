// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";

/// @notice Find a CREATE2 salt whose resulting address encodes `flags` in its
/// low 14 bits, as Uniswap v4 requires for hooks.
library HookMiner {
    uint256 internal constant MAX_LOOP = 500_000;

    function find(address deployer, uint160 flags, bytes memory initCode) internal view returns (address, bytes32) {
        bytes32 codeHash = keccak256(initCode);
        for (uint256 i; i < MAX_LOOP; ++i) {
            bytes32 salt = bytes32(i);
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, codeHash)))));
            if (uint160(a) & Hooks.ALL_HOOK_MASK == flags && a.code.length == 0) return (a, salt);
        }
        revert("HookMiner: no salt found");
    }
}
