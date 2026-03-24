pragma circom 2.1.0;

include "./hasher.circom";

// DualMux: selects ordering of two inputs based on binary selector s
// if s == 0: out[0] = in[0], out[1] = in[1]  (in[0] is left)
// if s == 1: out[0] = in[1], out[1] = in[0]  (in[1] is left)
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// MerkleTreeChecker: verifies that a leaf is in a Merkle tree
// given the sibling path and direction indicators
//
// levels: depth of the Merkle tree
// leaf: the leaf value to verify
// pathElements[i]: sibling node at level i
// pathIndices[i]: 0 if current node is left child, 1 if right child
// root: the expected Merkle root (output to be compared by caller)
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component selectors[levels];
    component hashers[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== levelHashes[i];
        selectors[i].in[1] <== pathElements[i];
        selectors[i].s <== pathIndices[i];

        hashers[i] = HashLeftRight();
        hashers[i].left <== selectors[i].out[0];
        hashers[i].right <== selectors[i].out[1];

        levelHashes[i + 1] <== hashers[i].hash;
    }

    root <== levelHashes[levels];
}
