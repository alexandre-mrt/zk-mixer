// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Interface for the circomlibjs-generated Poseidon contract.
/// Deployed separately via poseidonContract.createCode(2) / generateABI(2).
interface IHasher {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @title MerkleTree
/// @notice Incremental Merkle tree using Poseidon hash over the BN254 scalar field.
///
/// @dev Algorithm:
///   - Depth `levels` (1–32), supporting up to 2^levels leaves.
///   - Leaf insertion is O(levels): walks from the leaf to the root, updating one
///     `filledSubtrees` entry per level (the rightmost non-empty sibling seen so far).
///   - Zero values are precomputed at deployment:
///       zeros[0] = 0
///       zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
///     These initialise `filledSubtrees` so that any unused subtree hashes correctly.
///
/// Ring buffer (root history):
///   - The last ROOT_HISTORY_SIZE roots are retained in a circular array `roots[]`.
///   - `currentRootIndex` points to the most recently written slot.
///   - `isKnownRoot` scans the ring buffer backwards from `currentRootIndex`,
///     allowing withdrawals to be proven against slightly stale roots (in-flight tolerance).
///
/// Constraints:
///   - All leaf and node values must be < FIELD_SIZE (BN254 prime).
///   - `nextIndex` is monotonically increasing; the tree cannot shrink.
contract MerkleTree {
    /// @notice BN254 (alt_bn128) scalar field prime.
    /// All Poseidon inputs/outputs must be strictly less than this value.
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Number of recent roots retained for in-flight withdrawal tolerance.
    /// Withdrawals can reference any root within the last ROOT_HISTORY_SIZE insertions.
    uint32 public constant ROOT_HISTORY_SIZE = 30;

    /// @notice The deployed Poseidon(2) hasher contract.
    IHasher public immutable hasher;

    /// @notice Tree depth (number of levels, not counting the leaf level).
    uint32 public immutable levels;

    /// @notice filledSubtrees[i] is the rightmost leaf hash seen at depth i.
    /// @dev Initialised to zeros[i] = Poseidon(zeros[i-1], zeros[i-1]) at deploy time.
    ///      Updated on every insertion when a left-child node at level i is written.
    uint256[] public filledSubtrees;

    /// @notice Ring buffer holding the last ROOT_HISTORY_SIZE Merkle roots.
    /// @dev Written at index `(currentRootIndex + 1) % ROOT_HISTORY_SIZE` on each insertion.
    uint256[] public roots;

    /// @notice Index in `roots[]` of the most recently computed root.
    uint32 public currentRootIndex;

    /// @notice Index at which the next leaf will be inserted.
    /// @dev Monotonically increasing; reverts when it reaches 2^levels (tree full).
    uint32 public nextIndex;

    /// @param _levels  Tree depth (must satisfy 0 < _levels <= 32).
    /// @param _hasher  Address of the deployed Poseidon(2) contract.
    constructor(uint32 _levels, address _hasher) {
        require(_levels > 0 && _levels <= 32, "MerkleTree: levels out of range");
        require(_hasher != address(0), "MerkleTree: hasher is zero address");

        levels = _levels;
        hasher = IHasher(_hasher);

        // Compute zero values bottom-up at deploy time using the live hasher.
        // zeros[0] = 0 (empty leaf)
        // zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
        uint256 currentZero = 0;
        for (uint32 i = 0; i < _levels; i++) {
            filledSubtrees.push(currentZero);
            currentZero = hashLeftRight(currentZero, currentZero);
        }

        roots = new uint256[](ROOT_HISTORY_SIZE);
        roots[0] = currentZero; // initial root of empty tree
    }

    /// @notice Hash two BN254 field elements using Poseidon.
    /// @dev Delegates to the external `hasher` contract.
    ///      Both inputs must be < FIELD_SIZE; reverts otherwise.
    /// @param _left  Left child value.
    /// @param _right Right child value.
    /// @return       Poseidon(_left, _right).
    function hashLeftRight(uint256 _left, uint256 _right) public view returns (uint256) {
        require(_left < FIELD_SIZE, "MerkleTree: left overflow");
        require(_right < FIELD_SIZE, "MerkleTree: right overflow");
        return hasher.poseidon([_left, _right]);
    }

    /// @notice Insert a leaf into the tree and record the new Merkle root.
    /// @dev O(levels) gas. Updates `filledSubtrees` for each left-child on the path,
    ///      then writes the new root into the ring buffer.
    /// @param _leaf  The leaf value to insert (must be a valid field element).
    /// @return index The 0-based leaf index assigned to this insertion.
    function _insert(uint256 _leaf) internal returns (uint32 index) {
        uint32 _nextIndex = nextIndex;
        require(_nextIndex < uint32(2) ** levels, "MerkleTree: tree is full");

        uint32 currentIndex = _nextIndex;
        uint256 currentLevelHash = _leaf;

        for (uint32 i = 0; i < levels; i++) {
            uint256 left;
            uint256 right;

            if (currentIndex % 2 == 0) {
                // Current node is a left child: save it, fill right with zero
                left = currentLevelHash;
                right = filledSubtrees[i];
                filledSubtrees[i] = currentLevelHash;
            } else {
                // Current node is a right child: left sibling is already filled
                left = filledSubtrees[i];
                right = currentLevelHash;
            }

            currentLevelHash = hashLeftRight(left, right);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = currentLevelHash;
        nextIndex = _nextIndex + 1;

        return _nextIndex;
    }

    /// @notice Check whether `_root` appears anywhere in the root ring buffer.
    /// @dev Scans backwards from `currentRootIndex` through all ROOT_HISTORY_SIZE slots.
    ///      Returns false immediately for the zero root (never a valid tree root).
    /// @param _root  Candidate Merkle root to verify.
    /// @return       True if `_root` is found in the history, false otherwise.
    function isKnownRoot(uint256 _root) public view returns (bool) {
        if (_root == 0) return false;

        uint32 _currentRootIndex = currentRootIndex;
        uint32 i = _currentRootIndex;

        do {
            if (_root == roots[i]) return true;
            if (i == 0) {
                i = ROOT_HISTORY_SIZE - 1;
            } else {
                i--;
            }
        } while (i != _currentRootIndex);

        return false;
    }

    /// @notice Return the most recently inserted Merkle root.
    /// @return The root at `roots[currentRootIndex]`.
    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }
}
