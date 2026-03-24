// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Interface for the circomlibjs-generated Poseidon contract.
/// Deployed separately via poseidonContract.createCode(2) / generateABI(2).
interface IHasher {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @notice Incremental Merkle tree using Poseidon hash.
/// Stores the last ROOT_HISTORY_SIZE roots to support in-flight withdrawals.
contract MerkleTree {
    uint256 public constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant ROOT_HISTORY_SIZE = 30;

    IHasher public immutable hasher;
    uint32 public immutable levels;

    /// @dev filledSubtrees[i] = rightmost leaf hash seen at depth i.
    ///      Initialized to zeros[i] = Poseidon(zeros[i-1], zeros[i-1]).
    uint256[] public filledSubtrees;

    /// @dev Ring buffer of the last ROOT_HISTORY_SIZE Merkle roots.
    uint256[] public roots;

    uint32 public currentRootIndex;
    uint32 public nextIndex;

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

    /// @notice Hash two field elements using Poseidon.
    function hashLeftRight(uint256 _left, uint256 _right) public view returns (uint256) {
        require(_left < FIELD_SIZE, "MerkleTree: left overflow");
        require(_right < FIELD_SIZE, "MerkleTree: right overflow");
        return hasher.poseidon([_left, _right]);
    }

    /// @notice Insert a leaf into the tree. Returns the leaf index.
    /// @dev O(levels) gas. Updates filledSubtrees and pushes a new root.
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

    /// @notice Check whether _root appears in the root history.
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

    /// @notice Return the most recently inserted root.
    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }
}
