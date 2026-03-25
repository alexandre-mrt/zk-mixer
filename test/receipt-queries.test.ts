import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5; // capacity = 32 slots
const DENOMINATION = ethers.parseEther("0.1");

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
  await time.increase(24 * 60 * 60 + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

function decodeTokenURI(uri: string): {
  name: string;
  attributes: Array<{ trait_type: string; value: string }>;
} {
  const base64Part = uri.replace("data:application/json;base64,", "");
  return JSON.parse(Buffer.from(base64Part, "base64").toString("utf8"));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployWithReceiptFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

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

  return { mixer, receipt, owner, alice, bob, carol };
}

async function deployWithoutReceiptFixture() {
  const [owner, alice] = await ethers.getSigners();

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

  return { mixer, owner, alice };
}

// ---------------------------------------------------------------------------
// Receipt Queries
// ---------------------------------------------------------------------------

describe("Receipt Queries", function () {
  // -------------------------------------------------------------------------
  // ownerOf — boundary lookups
  // -------------------------------------------------------------------------

  it("ownerOf(0) returns first depositor after 1 deposit", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.ownerOf(0n)).to.equal(await alice.getAddress());
  });

  it("ownerOf(N-1) returns last depositor after N deposits", async function () {
    const { mixer, receipt, alice, bob } = await loadFixture(deployWithReceiptFixture);

    const N = 4;
    // alice does N-1 deposits, bob does the last one
    for (let i = 0; i < N - 1; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }
    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });

    // token N-1 (0-indexed) must belong to bob
    expect(await receipt.ownerOf(BigInt(N - 1))).to.equal(await bob.getAddress());
  });

  it("ownerOf(N) reverts for non-existent token", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    // only token 0 exists — querying token 1 must revert
    await expect(receipt.ownerOf(1n)).to.be.revertedWithCustomError(
      receipt,
      "ERC721NonexistentToken"
    );
  });

  // -------------------------------------------------------------------------
  // balanceOf — supply tracking
  // -------------------------------------------------------------------------

  it("balanceOf returns 0 for non-depositor", async function () {
    const { receipt, bob } = await loadFixture(deployWithReceiptFixture);

    expect(await receipt.balanceOf(await bob.getAddress())).to.equal(0n);
  });

  it("balanceOf increments per deposit for same user", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
    const aliceAddr = await alice.getAddress();

    expect(await receipt.balanceOf(aliceAddr)).to.equal(0n);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(aliceAddr)).to.equal(1n);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(aliceAddr)).to.equal(2n);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    expect(await receipt.balanceOf(aliceAddr)).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // tokenCommitment and tokenTimestamp lookups
  // -------------------------------------------------------------------------

  it("tokenCommitment maps tokenId to correct commitment", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
    const commitment = randomCommitment();

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
  });

  it("tokenTimestamp maps tokenId to non-zero value", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.tokenTimestamp(0n)).to.be.greaterThan(0n);
  });

  // -------------------------------------------------------------------------
  // Multi-user: unique tokens and correct ownership
  // -------------------------------------------------------------------------

  it("3 users deposit: each has unique token and correct owner", async function () {
    const { mixer, receipt, alice, bob, carol } = await loadFixture(
      deployWithReceiptFixture
    );

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(bob).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(carol).deposit(randomCommitment(), { value: DENOMINATION });

    const aliceAddr = await alice.getAddress();
    const bobAddr = await bob.getAddress();
    const carolAddr = await carol.getAddress();

    // Each user owns exactly one token
    expect(await receipt.balanceOf(aliceAddr)).to.equal(1n);
    expect(await receipt.balanceOf(bobAddr)).to.equal(1n);
    expect(await receipt.balanceOf(carolAddr)).to.equal(1n);

    // Tokens are sequential and tied to the depositor
    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.ownerOf(1n)).to.equal(bobAddr);
    expect(await receipt.ownerOf(2n)).to.equal(carolAddr);
  });

  // -------------------------------------------------------------------------
  // No receipt contract wired: ownerOf has nothing to query
  // -------------------------------------------------------------------------

  it("deposit without receipt: ownerOf reverts (no tokens minted)", async function () {
    const { mixer, alice } = await loadFixture(deployWithoutReceiptFixture);

    // Confirm receipt is not configured
    expect(await mixer.depositReceipt()).to.equal(ethers.ZeroAddress);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });

    // Deploy a standalone receipt contract to verify no tokens were issued
    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const standaloneReceipt = (await DepositReceiptFactory.deploy(
      await mixer.getAddress()
    )) as unknown as DepositReceipt;

    // No minting occurred — token 0 must not exist
    await expect(standaloneReceipt.ownerOf(0n)).to.be.revertedWithCustomError(
      standaloneReceipt,
      "ERC721NonexistentToken"
    );
  });

  // -------------------------------------------------------------------------
  // Pause / unpause: receipt data remains queryable
  // -------------------------------------------------------------------------

  it("receipt survives pause/unpause (still queryable)", async function () {
    const { mixer, receipt, owner, alice } = await loadFixture(deployWithReceiptFixture);
    const aliceAddr = await alice.getAddress();
    const commitment = randomCommitment();

    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    // Pause the mixer
    await mixer.connect(owner).pause();

    // Receipt data must still be fully queryable while paused
    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.balanceOf(aliceAddr)).to.equal(1n);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
    expect(await receipt.tokenTimestamp(0n)).to.be.greaterThan(0n);

    // Unpause and verify nothing changed
    await mixer.connect(owner).unpause();

    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.balanceOf(aliceAddr)).to.equal(1n);
    expect(await receipt.tokenCommitment(0n)).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // 10 rapid deposits: receipt data correctness
  // -------------------------------------------------------------------------

  it("receipt data is correct after 10 rapid deposits", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);
    const aliceAddr = await alice.getAddress();

    const commitments: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(alice).deposit(c, { value: DENOMINATION });
    }

    // Supply tracking
    expect(await receipt.balanceOf(aliceAddr)).to.equal(10n);

    // Boundary ownership
    expect(await receipt.ownerOf(0n)).to.equal(aliceAddr);
    expect(await receipt.ownerOf(9n)).to.equal(aliceAddr);

    // All commitments and timestamps stored correctly
    for (let i = 0; i < 10; i++) {
      expect(await receipt.tokenCommitment(BigInt(i))).to.equal(commitments[i]);
      expect(await receipt.tokenTimestamp(BigInt(i))).to.be.greaterThan(0n);
    }

    // Token 10 must not exist
    await expect(receipt.ownerOf(10n)).to.be.revertedWithCustomError(
      receipt,
      "ERC721NonexistentToken"
    );
  });

  // -------------------------------------------------------------------------
  // tokenURI: prefix check for all tokens
  // -------------------------------------------------------------------------

  it("tokenURI starts with data:application/json;base64 for all tokens", async function () {
    const { mixer, receipt, alice } = await loadFixture(deployWithReceiptFixture);

    const N = 5;
    for (let i = 0; i < N; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    for (let i = 0; i < N; i++) {
      const uri = await receipt.tokenURI(BigInt(i));
      expect(uri).to.match(/^data:application\/json;base64,/);

      // Verify each URI is independently decodable and has the correct token id in name
      const meta = decodeTokenURI(uri);
      expect(meta.name).to.equal(`Deposit Receipt #${i}`);
    }
  });
});
