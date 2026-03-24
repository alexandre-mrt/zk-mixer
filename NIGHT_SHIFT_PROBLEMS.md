# Night Shift Problems — 2026-03-24

> Items that need your attention. Run `grep -r "NIGHT-SHIFT-REVIEW" .` to find marked code.

## Summary
- 1 uncertainty
- 0 tasks blocked
- 0 fixes failed
- 1 assumption made

## Problems

### UNCERTAINTY: circom not installed — circuits not compile-checked
- **Iteration**: 1
- **File**: circuits/withdraw.circom, circuits/merkle_tree.circom, circuits/hasher.circom, circuits/deposit.circom
- **What I needed**: circom 2.1.x binary to validate circuit syntax and constraints
- **What I did**: Verified Poseidon template signature by reading circomlib source at node_modules. Confirmed Poseidon(1) is valid — template accepts nInputs >= 1. Wrote all circuits following exact spec. Could not run `circom --r1cs` to confirm no parse errors.
- **Confidence**: HIGH (logic correct, syntax follows spec, Poseidon signature confirmed from source)
- **User action needed**: Run `bash scripts/compile-circuit.sh` after installing circom (`curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh && cargo install circom`) to validate circuits compile cleanly.

### ASSUMPTION: Groth16Verifier contract factory name
- **File**: scripts/deploy.ts:7
- **What I needed**: The exact contract name snarkjs generates in Verifier.sol
- **What I did**: Used "Groth16Verifier" — the name snarkjs 0.7.x generates. Marked with NIGHT-SHIFT-REVIEW comment.
- **Confidence**: MEDIUM
- **User action needed**: After running `bash scripts/generate-verifier.sh` and `bunx hardhat compile`, verify the contract name matches. Run: `ls artifacts/contracts/Verifier.sol/` — the JSON filename (minus .json) is the correct name. Update deploy script if different.
