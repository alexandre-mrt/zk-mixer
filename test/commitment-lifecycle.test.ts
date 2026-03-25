import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const ONE_DAY = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

async function timelockSetDepositReceipt(
  mixer: Mixer,
  owner: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  receiptAddress: string
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", receiptAddress]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

// ---------------------------------------------------------------------------
// Fixture — plain mixer, no receipt
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const [owner, depositor, depositor2] = await ethers.getSigners();

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

  return { mixer, owner, depositor, depositor2 };
}

// ---------------------------------------------------------------------------
// Fixture — mixer wired with DepositReceipt NFT
// ---------------------------------------------------------------------------

async function deployMixerWithReceiptFixture() {
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

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { mixer, receipt, owner, depositor };
}

// ---------------------------------------------------------------------------
// Commitment Lifecycle
// ---------------------------------------------------------------------------

describe("Commitment Lifecycle", function () {
  // -------------------------------------------------------------------------
  // 1. commitment starts unknown (isCommitted = false)
  // -------------------------------------------------------------------------

  it("commitment starts unknown (isCommitted = false)", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    expect(await mixer.isCommitted(commitment)).to.be.false;
    expect(await mixer.commitments(commitment)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 2. after deposit: isCommitted = true
  // -------------------------------------------------------------------------

  it("after deposit: isCommitted = true", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    expect(await mixer.isCommitted(commitment)).to.be.true;
    expect(await mixer.commitments(commitment)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 3. commitment has a leafIndex (getCommitmentIndex)
  // -------------------------------------------------------------------------

  it("commitment has a leafIndex (getCommitmentIndex)", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const c0 = randomCommitment();
    const c1 = randomCommitment();

    await mixer.connect(depositor).deposit(c0, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });

    expect(await mixer.getCommitmentIndex(c0)).to.equal(0n);
    expect(await mixer.getCommitmentIndex(c1)).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // 4. commitment is retrievable by index (indexToCommitment)
  // -------------------------------------------------------------------------

  it("commitment is retrievable by index (indexToCommitment)", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const leafIndex = await mixer.commitmentIndex(commitment);
    expect(await mixer.indexToCommitment(leafIndex)).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // 5. commitment appears in getCommitments pagination
  // -------------------------------------------------------------------------

  it("commitment appears in getCommitments pagination", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await mixer.connect(depositor).deposit(c0, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c2, { value: DENOMINATION });

    const page = await mixer.getCommitments(0, 3);
    expect(page.length).to.equal(3);
    expect(page[0]).to.equal(c0);
    expect(page[1]).to.equal(c1);
    expect(page[2]).to.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 6. commitment is part of Merkle root (isKnownRoot for current root)
  // -------------------------------------------------------------------------

  it("commitment is part of Merkle root (isKnownRoot for current root)", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    const rootBefore = await mixer.getLastRoot();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const rootAfter = await mixer.getLastRoot();

    // Root must have changed
    expect(rootAfter).to.not.equal(rootBefore);
    expect(rootAfter).to.not.equal(0n);

    // New root is in the root history ring buffer
    expect(await mixer.isKnownRoot(rootAfter)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 7. commitment persists after new deposits (still committed)
  // -------------------------------------------------------------------------

  it("commitment persists after new deposits (still committed)", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const first = randomCommitment();

    await mixer.connect(depositor).deposit(first, { value: DENOMINATION });

    // Add several more deposits after the first
    for (let i = 0; i < 4; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    // First commitment still recorded
    expect(await mixer.isCommitted(first)).to.be.true;
    expect(await mixer.getCommitmentIndex(first)).to.equal(0n);
    expect(await mixer.indexToCommitment(0)).to.equal(first);
  });

  // -------------------------------------------------------------------------
  // 8. commitment survives pause/unpause
  // -------------------------------------------------------------------------

  it("commitment survives pause/unpause", async function () {
    const { mixer, owner, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    // Pause, then unpause
    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();

    // State is unchanged
    expect(await mixer.isCommitted(commitment)).to.be.true;
    expect(await mixer.indexToCommitment(0)).to.equal(commitment);
    expect(await mixer.nextIndex()).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // 9. commitment is permanent (no way to remove)
  // -------------------------------------------------------------------------

  it("commitment is permanent (no way to remove)", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    // There is no removal function in Mixer — verify state is immutable
    // after multiple subsequent deposits and time passing.
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    await time.increase(60);
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await mixer.isCommitted(commitment)).to.be.true;
    expect(await mixer.getCommitmentIndex(commitment)).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // 10. duplicate commitment blocked on second attempt
  // -------------------------------------------------------------------------

  it("duplicate commitment blocked on second attempt", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    await expect(
      mixer.connect(depositor).deposit(commitment, { value: DENOMINATION })
    ).to.be.revertedWith("Mixer: duplicate commitment");

    // nextIndex must not have advanced
    expect(await mixer.nextIndex()).to.equal(1n);
  });

  // -------------------------------------------------------------------------
  // 11. receipt tracks commitment if configured
  // -------------------------------------------------------------------------

  it("receipt tracks commitment if configured", async function () {
    const { mixer, receipt, depositor } = await loadFixture(
      deployMixerWithReceiptFixture
    );
    const commitment = randomCommitment();

    expect(await receipt.balanceOf(await depositor.getAddress())).to.equal(0n);

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    // NFT minted for depositor
    expect(await receipt.balanceOf(await depositor.getAddress())).to.equal(1n);

    // On-chain state is still correct
    expect(await mixer.isCommitted(commitment)).to.be.true;
    expect(await mixer.indexToCommitment(0)).to.equal(commitment);
  });

  // -------------------------------------------------------------------------
  // 12. commitment in Deposit event matches on-chain state
  // -------------------------------------------------------------------------

  it("commitment in Deposit event matches on-chain state", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);
    const commitment = randomCommitment();

    // Capture the Deposit event
    const tx = await mixer
      .connect(depositor)
      .deposit(commitment, { value: DENOMINATION });
    const receipt = await tx.wait();

    // Decode the event from logs
    const iface = mixer.interface;
    const depositTopic = iface.getEvent("Deposit")?.topicHash;
    const log = receipt?.logs.find((l) => l.topics[0] === depositTopic);
    expect(log).to.not.be.undefined;

    const decoded = iface.parseLog({ topics: log!.topics, data: log!.data });
    expect(decoded).to.not.be.null;

    const eventCommitment: bigint = decoded!.args[0];
    const eventLeafIndex: bigint = decoded!.args[1];

    // Event values must match on-chain lookups
    expect(eventCommitment).to.equal(commitment);
    expect(await mixer.isCommitted(eventCommitment)).to.be.true;
    expect(await mixer.getCommitmentIndex(eventCommitment)).to.equal(eventLeafIndex);
    expect(await mixer.indexToCommitment(Number(eventLeafIndex))).to.equal(commitment);
  });
});
