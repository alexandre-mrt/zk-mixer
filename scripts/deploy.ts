import { ethers } from "hardhat";
// @ts-ignore
import { poseidonContract } from "circomlibjs";
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

  // Deploy Poseidon hasher
  console.log("\nDeploying Poseidon hasher...");
  const HasherFactory = new ethers.ContractFactory(
    poseidonContract.generateABI(2),
    poseidonContract.createCode(2),
    deployer
  );
  const hasherContract = await HasherFactory.deploy();
  await hasherContract.waitForDeployment();
  const hasherAddress = await hasherContract.getAddress();
  console.log("Hasher deployed to:", hasherAddress);

  // Deploy Verifier
  console.log(`\nDeploying ${VERIFIER_CONTRACT_NAME}...`);
  const Verifier = await ethers.getContractFactory(VERIFIER_CONTRACT_NAME);
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("Verifier deployed to:", verifierAddress);

  // Deploy Mixer with verifier address, denomination, Merkle tree height, and hasher
  console.log("\nDeploying Mixer...");
  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy(verifierAddress, DENOMINATION, MERKLE_TREE_HEIGHT, hasherAddress);
  await mixer.waitForDeployment();
  const mixerAddress = await mixer.getAddress();
  console.log("Mixer deployed to:", mixerAddress);

  // Deploy DepositReceipt (optional, informational NFT)
  console.log("\nDeploying DepositReceipt...");
  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const depositReceipt = await DepositReceiptFactory.deploy(mixerAddress);
  await depositReceipt.waitForDeployment();
  const depositReceiptAddress = await depositReceipt.getAddress();
  console.log("DepositReceipt deployed to:", depositReceiptAddress);

  // Register receipt contract in Mixer
  console.log("\nRegistering DepositReceipt in Mixer...");
  const mixerContract = await ethers.getContractAt("Mixer", mixerAddress);
  const setTx = await mixerContract.setDepositReceipt(depositReceiptAddress);
  await setTx.wait();
  console.log("DepositReceipt registered.");

  // Deploy MixerLens (read-only aggregator, no constructor args)
  console.log("\nDeploying MixerLens...");
  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = await MixerLensFactory.deploy();
  await mixerLens.waitForDeployment();
  const mixerLensAddress = await mixerLens.getAddress();
  console.log("MixerLens deployed to:", mixerLensAddress);

  // Save deployment addresses
  const network = await ethers.provider.getNetwork();
  const addresses = {
    hasher: hasherAddress,
    verifier: verifierAddress,
    mixer: mixerAddress,
    depositReceipt: depositReceiptAddress,
    mixerLens: mixerLensAddress,
    network: network.name,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    denomination: DENOMINATION.toString(),
    merkleTreeHeight: MERKLE_TREE_HEIGHT,
  };

  fs.writeFileSync("deployment.json", JSON.stringify(addresses, null, 2));
  console.log("\nDeployment addresses saved to deployment.json");
  console.log(JSON.stringify(addresses, null, 2));

  // Append to history
  const historyPath = "deployments-history.json";
  let history: any[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    }
  } catch {}

  history.push({
    ...addresses,
    deployedAt: new Date().toISOString(),
    blockNumber: await ethers.provider.getBlockNumber(),
  });

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  console.log(`Deployment history saved (${history.length} total deployments)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
