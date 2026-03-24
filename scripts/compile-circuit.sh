#!/bin/bash
set -e

echo "=== ZK Mixer Circuit Compilation ==="

# Create build directory
echo "Creating build directory..."
mkdir -p build/circuits

# Compile the withdraw circuit
echo "Compiling withdraw.circom..."
circom circuits/withdraw.circom --r1cs --wasm --sym -o build/circuits/

echo "Circuit compiled. Constraint count:"
npx snarkjs r1cs info build/circuits/withdraw.r1cs

# Download powers of tau if not present
# pot20 covers up to 2^20 constraints — safe for depth-20 Merkle tree
if [ ! -f build/circuits/pot20_final.ptau ]; then
  echo "Downloading powers of tau (pot20 hermez ceremony)..."
  if command -v wget &> /dev/null; then
    wget -O build/circuits/pot20_final.ptau \
      https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau
  else
    curl -L -o build/circuits/pot20_final.ptau \
      https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_20.ptau
  fi
  echo "Powers of tau downloaded."
else
  echo "Powers of tau already present, skipping download."
fi

# Groth16 setup — phase 2 (circuit-specific)
echo "Running Groth16 setup (phase 2)..."
npx snarkjs groth16 setup \
  build/circuits/withdraw.r1cs \
  build/circuits/pot20_final.ptau \
  build/circuits/withdraw_0000.zkey

# Contribute to the ceremony (development contribution)
echo "Contributing to ceremony..."
npx snarkjs zkey contribute \
  build/circuits/withdraw_0000.zkey \
  build/circuits/withdraw_final.zkey \
  --name="Dev contribution" \
  -v \
  -e="random entropy string $(date)"

# Export verification key
echo "Exporting verification key..."
npx snarkjs zkey export verificationkey \
  build/circuits/withdraw_final.zkey \
  build/circuits/verification_key.json

echo ""
echo "=== Circuit compilation complete ==="
echo "  R1CS:              build/circuits/withdraw.r1cs"
echo "  WASM:              build/circuits/withdraw_js/withdraw.wasm"
echo "  Final zkey:        build/circuits/withdraw_final.zkey"
echo "  Verification key:  build/circuits/verification_key.json"
