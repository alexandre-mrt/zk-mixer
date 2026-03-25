// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IMixerDeposit {
    function deposit(uint256 _commitment) external payable;
}

/// @notice Test helper: a contract (non-EOA) that can call Mixer.deposit.
/// Used to verify that smart contract addresses are not blocked from depositing.
/// NEVER deploy to production.
contract ContractDepositor {
    function deposit(address _mixer, uint256 _commitment, uint256 _value) external payable {
        IMixerDeposit(_mixer).deposit{value: _value}(_commitment);
    }

    receive() external payable {}
}
