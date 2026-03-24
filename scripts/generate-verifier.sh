#!/bin/bash
set -e

echo "=== Generating Solidity Verifier ==="

# Ensure the final zkey exists before proceeding
if [ ! -f build/circuits/withdraw_final.zkey ]; then
  echo "Error: build/circuits/withdraw_final.zkey not found."
  echo "Run 'bash scripts/compile-circuit.sh' first."
  exit 1
fi

# Export Solidity verifier from the final zkey
echo "Exporting Solidity verifier from withdraw_final.zkey..."
npx snarkjs zkey export solidityverifier \
  build/circuits/withdraw_final.zkey \
  contracts/Verifier.sol

# Fix pragma version to match Hardhat config (solidity 0.8.20)
# snarkjs generates ^0.6.11 — replace with ^0.8.20
echo "Patching pragma version to ^0.8.20..."
# macOS sed requires '' after -i; GNU sed accepts -i without argument
sed -i '' 's/pragma solidity \^0\.6\.11;/pragma solidity ^0.8.20;/' contracts/Verifier.sol 2>/dev/null || \
  sed -i 's/pragma solidity \^0\.6\.11;/pragma solidity ^0.8.20;/' contracts/Verifier.sol

echo ""
echo "=== Verifier generation complete ==="
echo "  Verifier contract: contracts/Verifier.sol"
echo ""
echo "NOTE: The verifier contract factory name is typically 'Groth16Verifier'."
echo "      Run 'bunx hardhat compile' and check artifacts to confirm the name."
