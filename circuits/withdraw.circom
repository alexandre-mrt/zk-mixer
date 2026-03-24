pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "./hasher.circom";
include "./merkle_tree.circom";

// Withdraw: core privacy circuit for the ZK mixer
//
// Proves that the prover knows a (secret, nullifier) pair whose
// commitment = Poseidon(secret, nullifier) is included in the
// Merkle tree with the given root, without revealing which leaf.
//
// Public inputs are included in the proof to prevent front-running.
template Withdraw(levels) {
    // Public inputs
    signal input root;
    signal input nullifierHash;
    signal input recipient;  // withdrawal destination address
    signal input relayer;    // relayer address bound to proof — prevents front-running
    signal input fee;        // relayer fee

    // Private inputs
    signal input secret;
    signal input nullifier;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    // 1. Compute commitment = Poseidon(secret, nullifier)
    component commitmentHasher = Hasher2();
    commitmentHasher.in[0] <== secret;
    commitmentHasher.in[1] <== nullifier;

    // 2. Compute nullifierHash = Poseidon(nullifier) and verify against public input
    // Poseidon(1) verified against circomlib poseidon.circom: template Poseidon(nInputs)
    // supports any nInputs >= 1 with inputs[nInputs] array
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHash === nullifierHasher.out;

    // 3. Verify Merkle proof: commitment is a leaf in the tree
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== commitmentHasher.hash;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    root === tree.root;

    // 4. Prevent front-running: bind recipient and fee into the proof
    // These square constraints include recipient and fee in the circuit
    // without adding meaningful logic — changing them would invalidate the proof
    signal recipientSquare;
    recipientSquare <== recipient * recipient;
    signal relayerSquare;
    relayerSquare <== relayer * relayer;
    signal feeSquare;
    feeSquare <== fee * fee;
}

component main {public [root, nullifierHash, recipient, relayer, fee]} = Withdraw(20);
