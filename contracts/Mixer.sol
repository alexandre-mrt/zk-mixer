// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MerkleTree.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

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

/// @title Mixer
/// @notice Privacy-preserving ETH mixer using zero-knowledge proofs (Groth16 + Poseidon Merkle tree).
///
/// @dev Flow:
///   1. Depositor computes commitment = Poseidon(secret, nullifier) off-chain.
///   2. Depositor calls `deposit(commitment)` with exactly `denomination` ETH.
///      The commitment is inserted as a leaf into the incremental Merkle tree.
///   3. To withdraw, the depositor generates a Groth16 proof off-chain proving:
///      - knowledge of a note (secret + nullifier) for a commitment in the tree
///      - the root is in the ring-buffer history (in-flight tolerance)
///      - the nullifierHash = Poseidon(nullifier) has not been spent
///   4. Anyone calls `withdraw(proof, root, nullifierHash, recipient, relayer, fee)`.
///      Funds are sent to `recipient` (minus `fee`) and `fee` to `relayer`.
///
/// Security model:
///   - Reentrancy: `nonReentrant` on deposit and withdraw; ETH transfer after state writes.
///   - Double-spend: `nullifierHashes` mapping prevents nullifier reuse.
///   - Root staleness: `isKnownRoot` checks a ring buffer of last ROOT_HISTORY_SIZE roots.
///   - Circuit binding: public signals must match [root, nullifierHash, recipient, relayer, fee].
///   - Emergency pause: owner can halt deposits and withdrawals via `pause()`.
///
/// Public signals ordering (must match circuit):
///   pubSignals[0] = root
///   pubSignals[1] = nullifierHash
///   pubSignals[2] = uint256(uint160(recipient))
///   pubSignals[3] = uint256(uint160(relayer))
///   pubSignals[4] = fee
contract Mixer is MerkleTree, ReentrancyGuard, Pausable, Ownable {
    /// @notice The deployed Groth16 verifier contract.
    IVerifier public immutable verifier;

    /// @notice Fixed deposit/withdrawal amount in wei.
    uint256 public immutable denomination;

    /// @notice Tracks spent nullifiers to prevent double-withdrawal.
    mapping(uint256 => bool) public nullifierHashes;

    /// @notice Tracks known commitments to prevent duplicate deposits.
    mapping(uint256 => bool) public commitments;

    /// @notice Emitted when a commitment is successfully inserted into the tree.
    /// @param commitment  Poseidon(secret, nullifier) provided by the depositor.
    /// @param leafIndex   Position of the commitment in the Merkle tree.
    /// @param timestamp   Block timestamp of the deposit.
    event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp);

    /// @notice Emitted on a successful withdrawal.
    /// @param to            Address that received `denomination - fee`.
    /// @param nullifierHash Poseidon(nullifier) consumed by this withdrawal.
    /// @param relayer       Address that received `fee` (may be address(0) when fee == 0).
    /// @param fee           Relayer fee in wei.
    event Withdrawal(
        address to,
        uint256 nullifierHash,
        address indexed relayer,
        uint256 fee
    );

    /// @param _verifier         Address of the deployed Groth16Verifier contract.
    /// @param _denomination     Fixed ETH amount (in wei) for each deposit/withdrawal.
    /// @param _merkleTreeHeight Depth of the incremental Merkle tree (1–32).
    /// @param _hasher           Address of the deployed Poseidon(2) hasher contract.
    constructor(
        address _verifier,
        uint256 _denomination,
        uint32 _merkleTreeHeight,
        address _hasher
    ) MerkleTree(_merkleTreeHeight, _hasher) Ownable(msg.sender) {
        require(_verifier != address(0), "Mixer: verifier is zero address");
        require(_denomination > 0, "Mixer: denomination must be > 0");

        verifier = IVerifier(_verifier);
        denomination = _denomination;
    }

    /// @notice Deposit exactly `denomination` ETH and insert the commitment into the Merkle tree.
    /// @dev The commitment must be a non-zero BN254 field element not previously used.
    ///      Reverts if the contract is paused or reentered.
    /// @param _commitment Poseidon(secret, nullifier) computed off-chain by the depositor.
    function deposit(uint256 _commitment) external payable nonReentrant whenNotPaused {
        require(msg.value == denomination, "Mixer: incorrect deposit amount");
        require(!commitments[_commitment], "Mixer: duplicate commitment");
        require(_commitment != 0, "Mixer: commitment is zero");
        require(_commitment < FIELD_SIZE, "Mixer: commitment >= field size");

        uint32 insertedIndex = _insert(_commitment);
        commitments[_commitment] = true;

        emit Deposit(_commitment, insertedIndex, block.timestamp);
    }

    /// @notice Withdraw funds by proving knowledge of a valid unspent note.
    /// @dev ETH transfers happen after all state writes (checks-effects-interactions pattern).
    ///      Reverts if the contract is paused or reentered.
    ///
    /// @param _pA            Groth16 proof point A (G1).
    /// @param _pB            Groth16 proof point B (G2).
    /// @param _pC            Groth16 proof point C (G1).
    /// @param _root          Merkle root the proof is anchored to (must appear in root history).
    /// @param _nullifierHash Poseidon(nullifier) — consumed to prevent double-spend.
    /// @param _recipient     Address receiving `denomination - fee`.
    /// @param _relayer       Address receiving `fee`; may be address(0) only when fee == 0.
    /// @param _fee           Relayer fee in wei; must be <= denomination.
    function withdraw(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 _root,
        uint256 _nullifierHash,
        address payable _recipient,
        address payable _relayer,
        uint256 _fee
    ) external nonReentrant whenNotPaused {
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

        // Mark nullifier spent BEFORE transferring ETH (checks-effects-interactions)
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

    /// @notice Pause all deposits and withdrawals.
    /// @dev Only callable by the contract owner. Emits {Paused}.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause deposits and withdrawals.
    /// @dev Only callable by the contract owner. Emits {Unpaused}.
    function unpause() external onlyOwner {
        _unpause();
    }
}
