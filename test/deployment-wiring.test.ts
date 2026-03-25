import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
// @ts-ignore
import { poseidonContract } from "circomlibjs";
import type { Mixer, MixerLens, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants — match the production deploy script values
// ---------------------------------------------------------------------------

const DENOMINATION = ethers.parseEther("0.1");
const MERKLE_TREE_HEIGHT = 20;
const ONE_DAY = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Deploy helpers (mirror what scripts/deploy.ts does)
// ---------------------------------------------------------------------------

async function deployHasherContract() {
  const [signer] = await ethers.getSigners();
  const abi = poseidonContract.generateABI(2);
  const bytecode: string = poseidonContract.createCode(2);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract;
}

async function fullDeployFixture() {
  const [deployer] = await ethers.getSigners();

  // 1. Hasher
  const hasherContract = await deployHasherContract();
  const hasherAddress = await hasherContract.getAddress();

  // 2. Verifier
  const VerifierFactory = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();

  // 3. Mixer
  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;
  await mixer.waitForDeployment();
  const mixerAddress = await mixer.getAddress();

  // 4. DepositReceipt
  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const depositReceipt = (await DepositReceiptFactory.deploy(mixerAddress)) as unknown as DepositReceipt;
  await depositReceipt.waitForDeployment();
  const depositReceiptAddress = await depositReceipt.getAddress();

  // 5. Register receipt in Mixer (requires timelock)
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", depositReceiptAddress]
    )
  );
  await mixer.queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await mixer.setDepositReceipt(depositReceiptAddress);

  // 6. MixerLens
  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;
  await mixerLens.waitForDeployment();

  const network = await ethers.provider.getNetwork();

  return {
    deployer,
    hasherContract,
    hasherAddress,
    verifier,
    verifierAddress,
    mixer,
    mixerAddress,
    depositReceipt,
    depositReceiptAddress,
    mixerLens,
    chainId: network.chainId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Deployment Wiring", function () {
  it("Mixer.verifier() returns the deployed verifier address", async function () {
    const { mixer, verifierAddress } = await loadFixture(fullDeployFixture);
    expect(await mixer.verifier()).to.equal(verifierAddress);
  });

  it("Mixer.hasher() returns the deployed hasher address", async function () {
    const { mixer, hasherAddress } = await loadFixture(fullDeployFixture);
    expect(await mixer.hasher()).to.equal(hasherAddress);
  });

  it("Mixer.denomination() matches configured value", async function () {
    const { mixer } = await loadFixture(fullDeployFixture);
    expect(await mixer.denomination()).to.equal(DENOMINATION);
  });

  it("Mixer.levels() matches configured tree height", async function () {
    const { mixer } = await loadFixture(fullDeployFixture);
    expect(await mixer.levels()).to.equal(MERKLE_TREE_HEIGHT);
  });

  it("Mixer.owner() is the deployer", async function () {
    const { mixer, deployer } = await loadFixture(fullDeployFixture);
    expect(await mixer.owner()).to.equal(deployer.address);
  });

  it("DepositReceipt.mixer() matches Mixer address after setDepositReceipt", async function () {
    const { depositReceipt, mixerAddress } = await loadFixture(fullDeployFixture);
    expect(await depositReceipt.mixer()).to.equal(mixerAddress);
  });

  it("Mixer.depositReceipt() is set to DepositReceipt after wiring", async function () {
    const { mixer, depositReceiptAddress } = await loadFixture(fullDeployFixture);
    expect(await mixer.depositReceipt()).to.equal(depositReceiptAddress);
  });

  it("MixerLens.getSnapshot(mixer) returns valid data", async function () {
    const { mixer, mixerLens, deployer } = await loadFixture(fullDeployFixture);
    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.denomination).to.equal(DENOMINATION);
    expect(snapshot.owner).to.equal(deployer.address);
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.treeCapacity).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
    // lastRoot must be non-zero (initial Merkle tree root)
    expect(snapshot.lastRoot).to.not.equal(0n);
  });

  it("hasher.hashLeftRight(0, 0) returns a valid non-zero hash", async function () {
    const { mixer } = await loadFixture(fullDeployFixture);
    const hash = await mixer.hashLeftRight(0n, 0n);
    expect(hash).to.be.gt(0n);
  });

  it("all contracts are on the same chain (deployedChainId matches provider)", async function () {
    const { mixer, chainId } = await loadFixture(fullDeployFixture);
    expect(await mixer.deployedChainId()).to.equal(chainId);
  });

  it("full deploy flow: hasher → verifier → mixer → receipt → lens", async function () {
    const {
      hasherAddress,
      verifierAddress,
      mixer,
      mixerAddress,
      depositReceipt,
      depositReceiptAddress,
      mixerLens,
    } = await loadFixture(fullDeployFixture);

    // Verify every contract is properly deployed (has a non-zero address)
    expect(hasherAddress).to.be.properAddress;
    expect(verifierAddress).to.be.properAddress;
    expect(mixerAddress).to.be.properAddress;
    expect(depositReceiptAddress).to.be.properAddress;
    expect(await mixerLens.getAddress()).to.be.properAddress;

    // Verify cross-references
    expect(await mixer.verifier()).to.equal(verifierAddress);
    expect(await mixer.hasher()).to.equal(hasherAddress);
    expect(await mixer.depositReceipt()).to.equal(depositReceiptAddress);
    expect(await depositReceipt.mixer()).to.equal(mixerAddress);
  });
});
