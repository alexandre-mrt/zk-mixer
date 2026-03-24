# Night Shift Problems — 2026-03-24

> Items that need your attention. Run `grep -r "NIGHT-SHIFT-REVIEW" .` to find marked code.

## Summary
- 1 uncertainty
- 0 tasks blocked
- 0 fixes failed
- 1 assumption made

## Problems

### ASSUMPTION: Groth16Verifier contract factory name
- **File**: scripts/deploy.ts:7
- **What I needed**: The exact contract name snarkjs generates in Verifier.sol
- **What I did**: Used "Groth16Verifier" — the name snarkjs 0.7.x generates. Marked with NIGHT-SHIFT-REVIEW comment.
- **Confidence**: MEDIUM
- **User action needed**: After running `bash scripts/generate-verifier.sh` and `bunx hardhat compile`, verify the contract name matches. Run: `ls artifacts/contracts/Verifier.sol/` — the JSON filename (minus .json) is the correct name. Update `VERIFIER_CONTRACT_NAME` in scripts/deploy.ts if different.
