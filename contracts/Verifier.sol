// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// NIGHT-SHIFT-REVIEW: Placeholder verifier — replace with snarkjs output.
// Run: bash scripts/generate-verifier.sh
// The generated file will define contract Groth16Verifier with the same
// verifyProof signature. Delete this file before deploying to production.

/// @notice Placeholder Groth16 verifier.
/// Replaced by the snarkjs-generated Verifier.sol after circuit compilation.
/// Always returns true — FOR DEVELOPMENT ONLY, never deploy to mainnet.
contract Groth16Verifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[5] calldata
    ) external view returns (bool) {
        // NIGHT-SHIFT-REVIEW: placeholder, replace with real verifier
        require(block.chainid == 31337, "Groth16Verifier: placeholder verifier, only works on Hardhat network");
        return true;
    }
}
