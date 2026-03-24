import { ethers } from "hardhat";
import fs from "fs";

// NIGHT-SHIFT-REVIEW: snarkjs generates "Groth16Verifier" as the contract name.
// Verify by running: bunx hardhat compile && ls artifacts/contracts/Verifier.sol/
// If the name differs, update VERIFIER_CONTRACT_NAME below.
const VERIFIER_CONTRACT_NAME = "Groth16Verifier";

const DENOMINATION = ethers.parseEther("0.1");
const MERKLE_TREE_HEIGHT = 20;

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with:", deployer.address);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  // Deploy Verifier
  console.log(`\nDeploying ${VERIFIER_CONTRACT_NAME}...`);
  const Verifier = await ethers.getContractFactory(VERIFIER_CONTRACT_NAME);
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("Verifier deployed to:", verifierAddress);

  // Deploy Mixer with verifier address, denomination, and Merkle tree height
  console.log("\nDeploying Mixer...");
  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy(verifierAddress, DENOMINATION, MERKLE_TREE_HEIGHT);
  await mixer.waitForDeployment();
  const mixerAddress = await mixer.getAddress();
  console.log("Mixer deployed to:", mixerAddress);

  // Save deployment addresses
  const network = await ethers.provider.getNetwork();
  const addresses = {
    verifier: verifierAddress,
    mixer: mixerAddress,
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    denomination: DENOMINATION.toString(),
    merkleTreeHeight: MERKLE_TREE_HEIGHT,
  };

  fs.writeFileSync("deployment.json", JSON.stringify(addresses, null, 2));
  console.log("\nDeployment addresses saved to deployment.json");
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
