import { expect } from "chai";
import { ethers } from "hardhat";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deploy a minimal placeholder verifier for use as a valid address.
 */
async function deployVerifier() {
  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  return Verifier.deploy();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Constructor Validation", function () {
  describe("Mixer", () => {
    it("reverts with zero verifier address", async () => {
      const hasherAddress = await deployHasher();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      await expect(
        MixerFactory.deploy(ZERO_ADDRESS, DENOMINATION, MERKLE_TREE_HEIGHT, hasherAddress)
      ).to.be.revertedWith("Mixer: verifier is zero address");
    });

    it("reverts with zero denomination", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          0n,
          MERKLE_TREE_HEIGHT,
          hasherAddress
        )
      ).to.be.revertedWith("Mixer: denomination must be > 0");
    });

    it("reverts with zero hasher address", async () => {
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          DENOMINATION,
          MERKLE_TREE_HEIGHT,
          ZERO_ADDRESS
        )
      ).to.be.revertedWith("MerkleTree: hasher is zero address");
    });

    it("reverts with levels = 0", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          DENOMINATION,
          0,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it("reverts with levels > 32", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      await expect(
        MixerFactory.deploy(
          await verifier.getAddress(),
          DENOMINATION,
          33,
          hasherAddress
        )
      ).to.be.revertedWith("MerkleTree: levels out of range");
    });

    it("succeeds with valid parameters", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.getAddress()).to.be.properAddress;
    });

    it("stores correct denomination", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.denomination()).to.equal(DENOMINATION);
    });

    it("stores correct levels", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.levels()).to.equal(MERKLE_TREE_HEIGHT);
    });

    it("stores correct verifier", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const verifierAddress = await verifier.getAddress();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        verifierAddress,
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.verifier()).to.equal(verifierAddress);
    });

    it("stores correct hasher", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.hasher()).to.equal(hasherAddress);
    });

    it("stores correct owner (msg.sender)", async () => {
      const [owner] = await ethers.getSigners();
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.owner()).to.equal(owner.address);
    });

    it("stores correct deployedChainId", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      const { chainId } = await ethers.provider.getNetwork();
      expect(await mixer.deployedChainId()).to.equal(chainId);
    });

    it("initializes nextIndex to 0", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.nextIndex()).to.equal(0n);
    });

    it("initializes paused to false", async () => {
      const hasherAddress = await deployHasher();
      const verifier = await deployVerifier();
      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer = (await MixerFactory.deploy(
        await verifier.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer.paused()).to.equal(false);
    });
  });

  describe("DepositReceipt", () => {
    it("reverts with zero mixer address", async () => {
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      await expect(
        DepositReceiptFactory.deploy(ZERO_ADDRESS)
      ).to.be.revertedWith("DepositReceipt: zero mixer");
    });

    it("stores correct mixer address", async () => {
      // Use any non-zero address as a stand-in for the mixer
      const [, placeholder] = await ethers.getSigners();
      const mixerAddress = placeholder.address;
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceiptFactory.deploy(mixerAddress);

      expect(await receipt.mixer()).to.equal(mixerAddress);
    });

    it("name is 'ZK Mixer Deposit Receipt'", async () => {
      const [, placeholder] = await ethers.getSigners();
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceiptFactory.deploy(placeholder.address);

      expect(await receipt.name()).to.equal("ZK Mixer Deposit Receipt");
    });

    it("symbol is 'ZKDR'", async () => {
      const [, placeholder] = await ethers.getSigners();
      const DepositReceiptFactory =
        await ethers.getContractFactory("DepositReceipt");
      const receipt = await DepositReceiptFactory.deploy(placeholder.address);

      expect(await receipt.symbol()).to.equal("ZKDR");
    });
  });

  describe("MixerLens", () => {
    it("deploys successfully (no constructor args)", async () => {
      const MixerLensFactory = await ethers.getContractFactory("MixerLens");
      const lens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

      expect(await lens.getAddress()).to.be.properAddress;
    });
  });
});
