pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

// Hasher2: Poseidon hash of 2 inputs
// Used for commitment = Poseidon(secret, nullifier)
template Hasher2() {
    signal input in[2];
    signal output hash;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== in[0];
    hasher.inputs[1] <== in[1];
    hash <== hasher.out;
}

// HashLeftRight: Poseidon hash of left and right inputs
// Used for Merkle tree internal node hashing
template HashLeftRight() {
    signal input left;
    signal input right;
    signal output hash;

    component hasher = Poseidon(2);
    hasher.inputs[0] <== left;
    hasher.inputs[1] <== right;
    hash <== hasher.out;
}
