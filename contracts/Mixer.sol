// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MerkleTree.sol";
import "./DepositReceipt.sol";
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

    /// @notice Chain ID at deployment time — used to prevent cross-chain replay attacks.
    uint256 public immutable deployedChainId;

    /// @notice Tracks spent nullifiers to prevent double-withdrawal.
    mapping(uint256 => bool) public nullifierHashes;

    /// @notice Tracks known commitments to prevent duplicate deposits.
    mapping(uint256 => bool) public commitments;

    /// @notice Maps a commitment to its leaf index in the Merkle tree.
    /// Allows clients to look up the tree position of any commitment without scanning events.
    mapping(uint256 => uint32) public commitmentIndex;

    /// @notice Optional ERC721 receipt contract. When set, mints a soulbound NFT on each deposit.
    /// The receipt is purely informational — the ZK proof is what proves ownership for withdrawal.
    DepositReceipt public depositReceipt;

    /// @notice Maximum number of deposits allowed per address (0 = unlimited).
    /// @dev Prevents a single address from dominating the anonymity set.
    uint256 public maxDepositsPerAddress;

    /// @notice Tracks the number of deposits made by each address.
    mapping(address => uint256) public depositsPerAddress;

    /// @notice Cumulative amount deposited across all deposits (in wei).
    uint256 public totalDeposited;

    /// @notice Cumulative amount withdrawn across all withdrawals (in wei).
    uint256 public totalWithdrawn;

    /// @notice Total number of withdrawals completed.
    uint256 public withdrawalCount;

    /// @notice Timelock delay for sensitive parameter changes.
    uint256 public constant TIMELOCK_DELAY = 1 days;

    struct PendingAction {
        bytes32 actionHash;
        uint256 executeAfter;
    }

    /// @notice The currently queued action, if any.
    PendingAction public pendingAction;

    /// @notice Emitted when a parameter change is queued.
    event ActionQueued(bytes32 indexed actionHash, uint256 executeAfter);

    /// @notice Emitted when a queued action is executed.
    event ActionExecuted(bytes32 indexed actionHash);

    /// @notice Emitted when a queued action is cancelled.
    event ActionCancelled(bytes32 indexed actionHash);

    /// @notice Emitted when the per-address deposit limit is updated.
    /// @param newMax New maximum deposits per address (0 = unlimited).
    event MaxDepositsPerAddressUpdated(uint256 newMax);

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
        deployedChainId = block.chainid;
    }

    /// @notice Queue a parameter change that takes effect after TIMELOCK_DELAY.
    /// @dev Only one action can be pending at a time. Replaces any existing pending action.
    /// @param _actionHash keccak256 of the action identifier and its arguments.
    function queueAction(bytes32 _actionHash) external onlyOwner {
        pendingAction = PendingAction({
            actionHash: _actionHash,
            executeAfter: block.timestamp + TIMELOCK_DELAY
        });
        emit ActionQueued(_actionHash, block.timestamp + TIMELOCK_DELAY);
    }

    /// @notice Cancel the pending action.
    function cancelAction() external onlyOwner {
        require(pendingAction.actionHash != bytes32(0), "Mixer: no pending action");
        emit ActionCancelled(pendingAction.actionHash);
        delete pendingAction;
    }

    /// @notice Checks that the pending action matches _actionHash and the delay has elapsed.
    ///         Clears the pending action after execution.
    modifier timelockReady(bytes32 _actionHash) {
        require(pendingAction.actionHash == _actionHash, "Mixer: action not queued");
        require(block.timestamp >= pendingAction.executeAfter, "Mixer: timelock not expired");
        _;
        delete pendingAction;
        emit ActionExecuted(_actionHash);
    }

    /// @notice Reverts if the current chain differs from the deployment chain.
    modifier onlyDeployedChain() {
        require(block.chainid == deployedChainId, "wrong chain");
        _;
    }

    /// @notice Deposit exactly `denomination` ETH and insert the commitment into the Merkle tree.
    /// @dev The commitment must be a non-zero BN254 field element not previously used.
    ///      Reverts if the contract is paused or reentered.
    /// @param _commitment Poseidon(secret, nullifier) computed off-chain by the depositor.
    function deposit(uint256 _commitment) external payable nonReentrant whenNotPaused onlyDeployedChain {
        require(msg.value == denomination, "Mixer: incorrect deposit amount");
        require(!commitments[_commitment], "Mixer: duplicate commitment");
        require(_commitment != 0, "Mixer: commitment is zero");
        require(_commitment < FIELD_SIZE, "Mixer: commitment >= field size");
        if (maxDepositsPerAddress > 0) {
            require(depositsPerAddress[msg.sender] < maxDepositsPerAddress, "Mixer: deposit limit reached");
        }

        uint32 insertedIndex = _insert(_commitment);
        commitments[_commitment] = true;
        commitmentIndex[_commitment] = insertedIndex;
        depositsPerAddress[msg.sender]++;
        totalDeposited += denomination;

        emit Deposit(_commitment, insertedIndex, block.timestamp);

        if (address(depositReceipt) != address(0)) {
            depositReceipt.mint(msg.sender, _commitment);
        }
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
    ) external nonReentrant whenNotPaused onlyDeployedChain {
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
        totalWithdrawn += denomination;
        withdrawalCount++;

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

    /// @notice Check if a nullifier hash has been spent
    function isSpent(uint256 _nullifierHash) external view returns (bool) {
        return nullifierHashes[_nullifierHash];
    }

    /// @notice Check if a commitment exists
    function isCommitted(uint256 _commitment) external view returns (bool) {
        return commitments[_commitment];
    }

    /// @notice Return the leaf index of a commitment in the Merkle tree.
    /// @dev Reverts if the commitment has not been deposited.
    /// @param _commitment The commitment whose tree position is requested.
    /// @return The zero-based leaf index assigned when the commitment was inserted.
    function getCommitmentIndex(uint256 _commitment) external view returns (uint32) {
        require(commitments[_commitment], "commitment not found");
        return commitmentIndex[_commitment];
    }

    /// @notice Get the current deposit count
    function getDepositCount() external view returns (uint32) {
        return nextIndex;
    }

    /// @notice Returns the size of the current anonymity set (deposits - withdrawals)
    function getAnonymitySetSize() external view returns (uint256) {
        return uint256(nextIndex) - withdrawalCount;
    }

    /// @notice Returns pool health metrics in a single call.
    /// @return anonymitySetSize Number of unspent deposits currently in the pool.
    /// @return treeUtilization  Percentage of Merkle tree capacity used (0–100).
    /// @return poolBalance      Current ETH balance of the contract (wei).
    /// @return isPaused         Whether the contract is currently paused.
    function getPoolHealth() external view returns (
        uint256 anonymitySetSize,
        uint256 treeUtilization,
        uint256 poolBalance,
        bool isPaused
    ) {
        uint256 capacity = uint256(2) ** levels;
        return (
            uint256(nextIndex) - withdrawalCount,
            capacity > 0 ? (uint256(nextIndex) * 100) / capacity : 0,
            address(this).balance,
            paused()
        );
    }

    /// @notice Return cumulative pool statistics in a single call.
    /// @return _totalDeposited  Sum of all deposited amounts (wei).
    /// @return _totalWithdrawn  Sum of all withdrawn amounts (wei).
    /// @return _depositCount    Number of deposits made (== nextIndex).
    /// @return _withdrawalCount Number of completed withdrawals.
    /// @return _poolBalance     Current ETH balance of the contract (wei).
    function getStats() external view returns (
        uint256 _totalDeposited,
        uint256 _totalWithdrawn,
        uint256 _depositCount,
        uint256 _withdrawalCount,
        uint256 _poolBalance
    ) {
        return (totalDeposited, totalWithdrawn, nextIndex, withdrawalCount, address(this).balance);
    }

    /// @notice Sets the maximum number of deposits allowed per address.
    /// @dev Must be preceded by queueAction(keccak256(abi.encode("setMaxDepositsPerAddress", _max)))
    ///      and waited TIMELOCK_DELAY. Set to 0 to remove the limit (default).
    /// @param _max Maximum deposits per address (0 = unlimited).
    function setMaxDepositsPerAddress(uint256 _max)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("setMaxDepositsPerAddress", _max)))
    {
        maxDepositsPerAddress = _max;
        emit MaxDepositsPerAddressUpdated(_max);
    }

    /// @notice Returns how many more deposits an address can make.
    /// @dev Returns type(uint256).max when no limit is configured.
    /// @param _addr The address to query.
    /// @return Remaining deposits allowed (type(uint256).max if unlimited).
    function getRemainingDeposits(address _addr) external view returns (uint256) {
        if (maxDepositsPerAddress == 0) return type(uint256).max;
        uint256 used = depositsPerAddress[_addr];
        return used >= maxDepositsPerAddress ? 0 : maxDepositsPerAddress - used;
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

    /// @notice Set (or unset) the optional ERC721 deposit receipt contract.
    /// @dev Must be preceded by queueAction(keccak256(abi.encode("setDepositReceipt", _receipt)))
    ///      and waited TIMELOCK_DELAY. Pass address(0) to disable receipt minting.
    /// @param _receipt Address of a deployed DepositReceipt contract, or address(0) to disable.
    function setDepositReceipt(address _receipt)
        external
        onlyOwner
        timelockReady(keccak256(abi.encode("setDepositReceipt", _receipt)))
    {
        depositReceipt = DepositReceipt(_receipt);
    }
}
