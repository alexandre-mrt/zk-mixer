import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function timelockSetDepositReceipt(mixer: Mixer, owner: Signer, receiptAddress: string): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], ["setDepositReceipt", receiptAddress])
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(24 * 60 * 60 + 1); // 1 day + 1 second
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

async function deployMixerWithReceiptFixture() {
  const [owner, depositor, other] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  // Register receipt in Mixer (requires timelock)
  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, depositor, other };
}

async function deployMixerWithoutReceiptFixture() {
  const [owner, depositor] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  // Intentionally do NOT set depositReceipt — leave it as address(0)

  return { mixer, owner, depositor };
}

// ---------------------------------------------------------------------------
// DepositReceipt
// ---------------------------------------------------------------------------

describe("DepositReceipt", function () {
  // -------------------------------------------------------------------------
  // 1. Deployment
  // -------------------------------------------------------------------------

  describe("Deployment", function () {
    it("stores the mixer address as immutable", async function () {
      const { mixer, receipt } = await loadFixture(deployMixerWithReceiptFixture);
      expect(await receipt.mixer()).to.equal(await mixer.getAddress());
    });

    it("reverts when deployed with zero mixer address", async function () {
      const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      await expect(
        DepositReceiptFactory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("DepositReceipt: zero mixer");
    });

    it("has the correct ERC721 name and symbol", async function () {
      const { receipt } = await loadFixture(deployMixerWithReceiptFixture);
      expect(await receipt.name()).to.equal("ZK Mixer Deposit Receipt");
      expect(await receipt.symbol()).to.equal("ZKDR");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Minting on deposit
  // -------------------------------------------------------------------------

  describe("Minting on deposit", function () {
    it("mints a receipt NFT to the depositor on deposit", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      const commitment = randomCommitment();

      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

      expect(await receipt.balanceOf(await depositor.getAddress())).to.equal(1n);
    });

    it("assigns tokenId 0 to the first deposit", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      const commitment = randomCommitment();

      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

      expect(await receipt.ownerOf(0n)).to.equal(await depositor.getAddress());
    });

    it("assigns sequential token IDs across multiple deposits", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);

      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

      expect(await receipt.balanceOf(await depositor.getAddress())).to.equal(3n);
      expect(await receipt.ownerOf(0n)).to.equal(await depositor.getAddress());
      expect(await receipt.ownerOf(1n)).to.equal(await depositor.getAddress());
      expect(await receipt.ownerOf(2n)).to.equal(await depositor.getAddress());
    });

    it("stores the commitment on the token", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      const commitment = randomCommitment();

      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

      expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    });

    it("stores a non-zero timestamp on the token", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      const commitment = randomCommitment();

      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

      expect(await receipt.tokenTimestamp(0n)).to.be.greaterThan(0n);
    });

    it("stores the correct block timestamp on the token", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      const commitment = randomCommitment();

      const tx = await mixer
        .connect(depositor)
        .deposit(commitment, { value: DENOMINATION });
      const block = await ethers.provider.getBlock(tx.blockNumber!);

      expect(await receipt.tokenTimestamp(0n)).to.equal(BigInt(block!.timestamp));
    });
  });

  // -------------------------------------------------------------------------
  // 3. Soulbound — transfers blocked
  // -------------------------------------------------------------------------

  describe("Soulbound (non-transferable)", function () {
    it("reverts on safeTransferFrom (owner to other)", async function () {
      const { mixer, receipt, depositor, other } = await loadFixture(
        deployMixerWithReceiptFixture
      );
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
      const depositorAddr = await depositor.getAddress();
      const otherAddr = await other.getAddress();

      await expect(
        receipt
          .connect(depositor)
          ["safeTransferFrom(address,address,uint256)"](depositorAddr, otherAddr, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });

    it("reverts on transferFrom (owner to other)", async function () {
      const { mixer, receipt, depositor, other } = await loadFixture(
        deployMixerWithReceiptFixture
      );
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
      const depositorAddr = await depositor.getAddress();
      const otherAddr = await other.getAddress();

      await expect(
        receipt
          .connect(depositor)
          .transferFrom(depositorAddr, otherAddr, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });
  });

  // -------------------------------------------------------------------------
  // 4. No receipt when depositReceipt not set
  // -------------------------------------------------------------------------

  describe("No receipt when not configured", function () {
    it("deposit succeeds without minting an NFT when depositReceipt is address(0)", async function () {
      const { mixer, depositor } = await loadFixture(deployMixerWithoutReceiptFixture);

      // depositReceipt is not set — should not revert
      const commitment = randomCommitment();
      await expect(
        mixer.connect(depositor).deposit(commitment, { value: DENOMINATION })
      ).to.not.be.reverted;
    });

    it("depositReceipt is address(0) by default", async function () {
      const { mixer } = await loadFixture(deployMixerWithoutReceiptFixture);
      expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);
    });
  });

  // -------------------------------------------------------------------------
  // 5. tokenURI metadata
  // -------------------------------------------------------------------------

  describe("tokenURI", function () {
    it("returns a valid base64-encoded JSON URI for an existing token", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

      const uri = await receipt.tokenURI(0n);
      expect(uri).to.match(/^data:application\/json;base64,/);

      const base64Part = uri.replace("data:application/json;base64,", "");
      const decoded = Buffer.from(base64Part, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      expect(parsed).to.have.property("name");
      expect(parsed).to.have.property("attributes");
    });

    it("tokenURI name contains the correct token ID", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

      const uri = await receipt.tokenURI(1n);
      const base64Part = uri.replace("data:application/json;base64,", "");
      const decoded = Buffer.from(base64Part, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      expect(parsed.name).to.equal("Deposit Receipt #1");
    });

    it("tokenURI contains the correct commitment in attributes", async function () {
      const { mixer, receipt, depositor } = await loadFixture(deployMixerWithReceiptFixture);
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

      const uri = await receipt.tokenURI(0n);
      const base64Part = uri.replace("data:application/json;base64,", "");
      const decoded = Buffer.from(base64Part, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);

      const commitmentAttr = parsed.attributes.find(
        (a: { trait_type: string; value: string }) => a.trait_type === "Commitment"
      );
      expect(commitmentAttr).to.not.be.undefined;
      // Solidity toHexString pads to full uint256 (32 bytes = 64 hex chars + "0x" prefix)
      const expected = "0x" + commitment.toString(16).padStart(64, "0");
      expect(commitmentAttr.value.toLowerCase()).to.equal(expected.toLowerCase());
    });

    it("tokenURI reverts for a non-existent token", async function () {
      const { receipt } = await loadFixture(deployMixerWithReceiptFixture);
      await expect(receipt.tokenURI(999n)).to.be.revertedWithCustomError(receipt, "ERC721NonexistentToken");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Access control
  // -------------------------------------------------------------------------

  describe("Access control", function () {
    it("reverts when mint is called directly (not by mixer)", async function () {
      const { receipt, other } = await loadFixture(deployMixerWithReceiptFixture);

      await expect(
        receipt.connect(other).mint(await other.getAddress(), randomCommitment())
      ).to.be.revertedWith("DepositReceipt: only mixer");
    });

    it("only owner can call setDepositReceipt", async function () {
      const { mixer, receipt, depositor } = await loadFixture(
        deployMixerWithReceiptFixture
      );
      const addr = await receipt.getAddress();
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], ["setDepositReceipt", addr])
      );
      await expect(
        mixer.connect(depositor).queueAction(actionHash)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("owner can unset depositReceipt by passing address(0)", async function () {
      const { mixer, owner } = await loadFixture(deployMixerWithReceiptFixture);
      await timelockSetDepositReceipt(mixer, owner, ethers.ZeroAddress);
      expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);
    });
  });
});
