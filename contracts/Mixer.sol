// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MerkleTree.sol";

/// @notice Interface matching the snarkjs Groth16 verifier output.
/// Public signals order must match the circuit: [root, nullifierHash, recipient, relayer, fee]
interface IVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[5] calldata _pubSignals
    ) external view returns (bool);
}

/// @notice Privacy-preserving ETH mixer.
/// Users deposit a fixed denomination and can withdraw to any address
/// by submitting a Groth16 zero-knowledge proof.
///
/// Security model:
/// - Reentrancy: ETH transfers happen after state writes (nullifierHash marked spent before transfer)
/// - Double-spend: nullifierHashes mapping prevents reuse
/// - Root staleness: isKnownRoot checks ring buffer of last ROOT_HISTORY_SIZE roots
contract Mixer is MerkleTree {
    IVerifier public immutable verifier;

    /// @notice Fixed deposit/withdrawal amount in wei.
    uint256 public immutable denomination;

    /// @notice Tracks spent nullifiers to prevent double-withdrawal.
    mapping(uint256 => bool) public nullifierHashes;

    /// @notice Tracks known commitments to prevent duplicate deposits.
    mapping(uint256 => bool) public commitments;

    event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp);
    event Withdrawal(
        address to,
        uint256 nullifierHash,
        address indexed relayer,
        uint256 fee
    );

    constructor(
        address _verifier,
        uint256 _denomination,
        uint32 _merkleTreeHeight,
        address _hasher
    ) MerkleTree(_merkleTreeHeight, _hasher) {
        require(_verifier != address(0), "Mixer: verifier is zero address");
        require(_denomination > 0, "Mixer: denomination must be > 0");

        verifier = IVerifier(_verifier);
        denomination = _denomination;
    }

    /// @notice Deposit exactly `denomination` ETH and insert the commitment into the tree.
    /// @param _commitment Poseidon(secret, nullifier) computed off-chain by the depositor.
    function deposit(uint256 _commitment) external payable {
        require(msg.value == denomination, "Mixer: incorrect deposit amount");
        require(!commitments[_commitment], "Mixer: duplicate commitment");
        require(_commitment != 0, "Mixer: commitment is zero");
        require(_commitment < FIELD_SIZE, "Mixer: commitment >= field size");

        uint32 insertedIndex = _insert(_commitment);
        commitments[_commitment] = true;

        emit Deposit(_commitment, insertedIndex, block.timestamp);
    }

    /// @notice Withdraw funds by proving knowledge of a valid note.
    ///
    /// @param _pA  Groth16 proof point A
    /// @param _pB  Groth16 proof point B
    /// @param _pC  Groth16 proof point C
    /// @param _root        Merkle root the proof is anchored to (must be in history)
    /// @param _nullifierHash  Poseidon(nullifier) — prevents double-spend
    /// @param _recipient   Address receiving denomination - fee
    /// @param _relayer     Address receiving the fee (may be address(0) if no fee)
    /// @param _fee         Relayer fee in wei (<= denomination)
    function withdraw(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifierHash,
        address payable _recipient,
        address payable _relayer,
        uint256 _fee
    ) external {
        require(_fee <= denomination, "Mixer: fee exceeds denomination");
        require(_recipient != address(0), "Mixer: recipient is zero address");
        require(!nullifierHashes[_nullifierHash], "Mixer: already spent");
        require(isKnownRoot(_root), "Mixer: unknown root");

        // Public signals order must match circuit: [root, nullifierHash, recipient, relayer, fee]
        uint256[5] memory pubSignals = [
            _root,
            _nullifierHash,
            uint256(uint160(address(_recipient))),
            uint256(uint160(address(_relayer))),
            _fee
        ];

        require(
            verifier.verifyProof(_pA, _pB, _pC, pubSignals),
            "Mixer: invalid proof"
        );

        // Mark nullifier spent BEFORE transferring ETH (reentrancy protection)
        nullifierHashes[_nullifierHash] = true;

        uint256 withdrawAmount = denomination - _fee;

        (bool success, ) = _recipient.call{value: withdrawAmount}("");
        require(success, "Mixer: recipient transfer failed");

        if (_fee > 0) {
            require(_relayer != address(0), "Mixer: relayer is zero address for non-zero fee");
            (bool feeSuccess, ) = _relayer.call{value: _fee}("");
            require(feeSuccess, "Mixer: relayer transfer failed");
        }

        emit Withdrawal(_recipient, _nullifierHash, _relayer, _fee);
    }
}
