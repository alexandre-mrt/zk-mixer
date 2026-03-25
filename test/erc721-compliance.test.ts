import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

// ERC165 interface IDs
const ERC721_INTERFACE_ID = "0x80ac58cd";
const ERC165_INTERFACE_ID = "0x01ffc9a7";
const ERC721_METADATA_INTERFACE_ID = "0x5b5e139f";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function timelockSetDepositReceipt(
  mixer: Mixer,
  owner: Signer,
  receiptAddress: string
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", receiptAddress]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(24 * 60 * 60 + 1); // 1 day + 1 second
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

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

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// ERC721 Compliance Tests
// ---------------------------------------------------------------------------

describe("ERC721 Compliance — DepositReceipt (zk-mixer)", function () {
  // -------------------------------------------------------------------------
  // 1. Metadata
  // -------------------------------------------------------------------------

  describe("Metadata", function () {
    it("name() returns 'ZK Mixer Deposit Receipt'", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.name()).to.equal("ZK Mixer Deposit Receipt");
    });

    it("symbol() returns 'ZKDR'", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.symbol()).to.equal("ZKDR");
    });
  });

  // -------------------------------------------------------------------------
  // 2. balanceOf
  // -------------------------------------------------------------------------

  describe("balanceOf", function () {
    it("returns 0 for an address with no tokens", async function () {
      const { receipt, alice } = await loadFixture(deployFixture);
      expect(await receipt.balanceOf(alice.address)).to.equal(0n);
    });

    it("returns 1 after one deposit", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      expect(await receipt.balanceOf(alice.address)).to.equal(1n);
    });

    it("returns N for an address with N deposits", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      expect(await receipt.balanceOf(alice.address)).to.equal(3n);
    });

    it("counts are independent per address", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });
      expect(await receipt.balanceOf(alice.address)).to.equal(2n);
      expect(await receipt.balanceOf(bob.address)).to.equal(1n);
    });

    it("reverts for the zero address", async function () {
      const { receipt } = await loadFixture(deployFixture);
      await expect(
        receipt.balanceOf(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(receipt, "ERC721InvalidOwner");
    });
  });

  // -------------------------------------------------------------------------
  // 3. ownerOf
  // -------------------------------------------------------------------------

  describe("ownerOf", function () {
    it("returns the correct owner for each token", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
      await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });
      expect(await receipt.ownerOf(0n)).to.equal(alice.address);
      expect(await receipt.ownerOf(1n)).to.equal(bob.address);
    });

    it("reverts for a non-existent token", async function () {
      const { receipt } = await loadFixture(deployFixture);
      await expect(
        receipt.ownerOf(999n)
      ).to.be.revertedWithCustomError(receipt, "ERC721NonexistentToken");
    });
  });

  // -------------------------------------------------------------------------
  // 4. tokenURI
  // -------------------------------------------------------------------------

  describe("tokenURI", function () {
    it("returns a valid data URI for an existing token", async function () {
      const { mixer, receipt, alice } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

      const uri = await receipt.tokenURI(0n);
      expect(uri).to.match(/^data:application\/json;base64,/);

      const base64Part = uri.replace("data:application/json;base64,", "");
      const decoded = Buffer.from(base64Part, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      expect(parsed).to.have.property("name");
      expect(parsed).to.have.property("attributes");
    });

    it("reverts for a non-existent token", async function () {
      const { receipt } = await loadFixture(deployFixture);
      await expect(
        receipt.tokenURI(999n)
      ).to.be.revertedWithCustomError(receipt, "ERC721NonexistentToken");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Soulbound restrictions
  // -------------------------------------------------------------------------

  describe("Soulbound restrictions", function () {
    it("transferFrom reverts with soulbound message", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

      await expect(
        receipt.connect(alice).transferFrom(alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });

    it("safeTransferFrom(address,address,uint256) reverts with soulbound message", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

      await expect(
        receipt
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });

    it("safeTransferFrom(address,address,uint256,bytes) reverts with soulbound message", async function () {
      const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

      await expect(
        receipt
          .connect(alice)
          ["safeTransferFrom(address,address,uint256,bytes)"](
            alice.address,
            bob.address,
            0n,
            "0x"
          )
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });

    it("approve does not prevent the soulbound restriction on transfer", async function () {
      // approve itself is not blocked — only the subsequent transfer is blocked
      const { mixer, receipt, alice, bob } = await loadFixture(deployFixture);
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

      // approve should succeed (contract does not block it)
      await expect(
        receipt.connect(alice).approve(bob.address, 0n)
      ).to.not.be.reverted;

      // but transfer still reverts even with approval
      await expect(
        receipt.connect(bob).transferFrom(alice.address, bob.address, 0n)
      ).to.be.revertedWith("DepositReceipt: soulbound, non-transferable");
    });
  });

  // -------------------------------------------------------------------------
  // 6. supportsInterface
  // -------------------------------------------------------------------------

  describe("supportsInterface", function () {
    it("returns true for ERC721 interface (0x80ac58cd)", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface(ERC721_INTERFACE_ID)).to.equal(true);
    });

    it("returns true for ERC165 interface (0x01ffc9a7)", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface(ERC165_INTERFACE_ID)).to.equal(true);
    });

    it("returns true for ERC721Metadata interface (0x5b5e139f)", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface(ERC721_METADATA_INTERFACE_ID)).to.equal(true);
    });

    it("returns false for an unknown interface", async function () {
      const { receipt } = await loadFixture(deployFixture);
      expect(await receipt.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
