// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Create2Deployer
/// @notice Minimal CREATE2 factory used to place the hook at an address whose
/// low bits encode its Uniswap v4 permissions. Deployed by Mesa itself so the
/// deployment does not depend on a third-party deterministic deployer being
/// present on the chain.
contract Create2Deployer {
    event Deployed(address addr, bytes32 salt);

    error DeployFailed();

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        bytes memory code = initCode;
        assembly ("memory-safe") {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        emit Deployed(addr, salt);
    }

    function addressOf(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
