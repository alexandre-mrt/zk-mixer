pragma circom 2.1.0;

include "./hasher.circom";

// Deposit: computes the commitment from secret and nullifier
// commitment = Poseidon(secret, nullifier)
// Used for testing and off-chain commitment generation verification
template Deposit() {
    signal input secret;
    signal input nullifier;
    signal output commitment;

    component hasher = Hasher2();
    hasher.in[0] <== secret;
    hasher.in[1] <== nullifier;
    commitment <== hasher.hash;
}

component main = Deposit();
