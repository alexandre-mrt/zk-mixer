import { ethers } from "hardhat";
import { poseidonContract } from "circomlibjs";

// Number of inputs for the Poseidon hash used by MerkleTree (left + right).
const POSEIDON_INPUTS = 2;

/// Deploy a circomlibjs-generated Poseidon contract with 2 inputs.
/// The deployed contract exposes:
///   poseidon(uint256[2]) returns (uint256)
///   poseidon(bytes32[2]) returns (bytes32)
/// This satisfies the IHasher interface defined in MerkleTree.sol.
export async function deployHasher(): Promise<string> {
  const [signer] = await ethers.getSigners();

  const bytecode: string = poseidonContract.createCode(POSEIDON_INPUTS);
  const abi = poseidonContract.generateABI(POSEIDON_INPUTS);

  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  return contract.getAddress();
}
