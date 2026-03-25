// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test helper: verifier that always returns false.
/// Used to reliably trigger "Mixer: invalid proof" in tests.
/// NEVER deploy to production.
contract MockFalseVerifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[5] calldata
    ) external pure returns (bool) {
        return false;
    }
}
