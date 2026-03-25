import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DENOMINATION = ethers.parseEther("0.1");

// Small tree for fast stress tests — 2^3 = 8 leaf capacity
const SMALL_TREE_HEIGHT = 3;

// Height-5 tree for root-history wrap-around test — ROOT_HISTORY_SIZE = 30
// Need 31+ deposits to trigger wrap-around
const MEDIUM_TREE_HEIGHT = 5;

const ROOT_HISTORY_SIZE = 30;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(mixer: Mixer, signer: Signer, commitment?: bigint) {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return { commitment: c };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deploySmallTree() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    SMALL_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, depositor, recipient, relayer };
}

async function deployMediumTree() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MEDIUM_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, depositor, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Stress Tests
// ---------------------------------------------------------------------------

describe("Stress Tests", function () {
  // Height-3 tree: capacity = 8
  const SMALL_CAPACITY = 2 ** SMALL_TREE_HEIGHT; // 8

  it("fills tree to capacity (8 deposits)", async function () {
    const { mixer, depositor } = await loadFixture(deploySmallTree);

    const commitments: bigint[] = [];
    for (let i = 0; i < SMALL_CAPACITY; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await doDeposit(mixer, depositor, c);
    }

    expect(await mixer.nextIndex()).to.equal(BigInt(SMALL_CAPACITY));

    // All commitments must be tracked in the mapping
    for (const c of commitments) {
      expect(await mixer.commitments(c)).to.be.true;
    }
  });

  it("reverts on deposit when tree is full", async function () {
    const { mixer, depositor } = await loadFixture(deploySmallTree);

    // Fill tree to capacity
    for (let i = 0; i < SMALL_CAPACITY; i++) {
      await doDeposit(mixer, depositor);
    }

    // 9th deposit must revert
    await expect(doDeposit(mixer, depositor)).to.be.revertedWith(
      "MerkleTree: tree is full"
    );
  });

  it("root changes on every deposit", async function () {
    const { mixer, depositor } = await loadFixture(deploySmallTree);

    const roots: Set<bigint> = new Set();

    // Capture initial root before any deposit
    roots.add(await mixer.getLastRoot());

    for (let i = 0; i < SMALL_CAPACITY; i++) {
      await doDeposit(mixer, depositor);
      const root = await mixer.getLastRoot();
      roots.add(root);
    }

    // Each of the 8 deposits produces a unique root, plus the initial root
    expect(roots.size).to.equal(SMALL_CAPACITY + 1);
  });

  it("root history wraps correctly when > ROOT_HISTORY_SIZE deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployMediumTree);

    // Collect roots in insertion order (roots[0] = after deposit 1, etc.)
    const rootsInOrder: bigint[] = [];

    // Deposit ROOT_HISTORY_SIZE + 1 times to trigger wrap-around
    const TOTAL_DEPOSITS = ROOT_HISTORY_SIZE + 1;

    for (let i = 0; i < TOTAL_DEPOSITS; i++) {
      await doDeposit(mixer, depositor);
      rootsInOrder.push(await mixer.getLastRoot());
    }

    // The root from deposit #1 (index 0 in our array) should now be
    // overwritten — the ring buffer holds only the last ROOT_HISTORY_SIZE roots.
    const firstRoot = rootsInOrder[0];
    expect(await mixer.isKnownRoot(firstRoot)).to.be.false;

    // The most recent root (after the last deposit) must still be known
    const lastRoot = rootsInOrder[TOTAL_DEPOSITS - 1];
    expect(await mixer.isKnownRoot(lastRoot)).to.be.true;

    // The root just before wrap-around (deposit #ROOT_HISTORY_SIZE) is still within window
    const rootJustBeforeWrap = rootsInOrder[ROOT_HISTORY_SIZE - 1];
    expect(await mixer.isKnownRoot(rootJustBeforeWrap)).to.be.true;
  });

  it("withdrawal still works after many deposits", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMediumTree);

    // Make 20 deposits to build up tree state
    for (let i = 0; i < 20; i++) {
      await doDeposit(mixer, depositor);
    }

    // Withdraw using the current root and a fresh nullifier
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();

    await expect(
      mixer.connect(depositor).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        recipient.address,
        relayer.address,
        0n
      )
    ).to.emit(mixer, "Withdrawal");

    // Nullifier must now be marked spent
    expect(await mixer.nullifierHashes(nullifierHash)).to.be.true;
  });
});
