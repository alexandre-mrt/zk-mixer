# Night Shift Problems — 2026-03-24

> Items that need your attention. Run `grep -r "NIGHT-SHIFT-REVIEW" .` to find marked code.

## Summary
- 3 uncertainties
- 0 tasks blocked
- 0 fixes failed
- 2 assumptions made

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

### ASSUMPTION: deploy.ts missing hasher deployment
- **Iteration**: 2
- **File**: scripts/deploy.ts:33
- **What I needed**: Alignment between deploy script and Mixer constructor signature
- **What I did**: MerkleTree and Mixer constructors take `_hasher` address (as per task spec). The existing deploy.ts calls `Mixer.deploy(verifierAddress, DENOMINATION, MERKLE_TREE_HEIGHT)` with only 3 args — missing the hasher address. Did not modify deploy.ts (out of scope). Logged here.
- **Confidence**: HIGH (mismatch is confirmed — compile succeeds but deploy will revert)
- **User action needed**: Update scripts/deploy.ts to deploy the Poseidon hasher first. Add before the Mixer deploy:
  ```typescript
  import { poseidonContract } from "circomlibjs";
  const HasherFactory = new ethers.ContractFactory(
    poseidonContract.generateABI(2),
    poseidonContract.createCode(2),
    deployer
  );
  const hasherContract = await HasherFactory.deploy();
  await hasherContract.waitForDeployment();
  const hasherAddress = await hasherContract.getAddress();
  ```
  Then change `Mixer.deploy(verifierAddress, DENOMINATION, MERKLE_TREE_HEIGHT)` to
  `Mixer.deploy(verifierAddress, DENOMINATION, MERKLE_TREE_HEIGHT, hasherAddress)`

### DEPENDENCY: ethers v6 was missing from direct dependencies
- **Iteration**: 3
- **File**: package.json
- **What I needed**: ethers ^6.14.0 installed at the project root (required by @nomicfoundation/hardhat-ethers@3.x)
- **What I did**: The project declared no direct `ethers` dependency; bun resolved it as ethers@5.8.0 (from circomlibjs transitive). Running `npm install ethers@^6.14.0 --save --legacy-peer-deps` and then `bun install` fixed it. ethers@6.16.0 is now at node_modules/ethers. Added "ethers": "^6.14.0" to package.json.
- **Confidence**: HIGH (all 41 tests pass after fix)
- **User action needed**: None — the fix is applied. If bun.lock or node_modules is ever reset without the updated package.json, run `bun install` again to restore ethers v6.

### UNCERTAINTY: Verifier.sol placeholder always returns true
- **Iteration**: 2
- **File**: contracts/Verifier.sol
- **What I needed**: Real snarkjs-generated verifier
- **What I did**: Wrote a placeholder Groth16Verifier that returns true for all proofs. Marked with NIGHT-SHIFT-REVIEW. Required for compilation until circuits are compiled and snarkjs verifier is generated.
- **Confidence**: HIGH (placeholder is correct for dev; production needs the real verifier)
- **User action needed**: After running `bash scripts/compile-circuit.sh` and `bash scripts/generate-verifier.sh`, delete contracts/Verifier.sol and use the snarkjs-generated one. The generated contract name should be Groth16Verifier.
