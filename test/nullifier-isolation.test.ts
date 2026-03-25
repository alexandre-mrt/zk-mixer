import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// BN254 scalar field prime — all Poseidon inputs/outputs live in [0, FIELD_SIZE).
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");

// Zero-value dummy proof — the test verifier accepts any proof.
const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Poseidon helpers — initialised once via before() to avoid rebuilding per-test
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidon: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;

before(async () => {
  poseidon = await buildPoseidon();
  F = poseidon.F;
});

function computeCommitment(secret: bigint, nullifier: bigint): bigint {
  return F.toObject(poseidon([secret, nullifier]));
}

function computeNullifierHash(nullifier: bigint): bigint {
  return F.toObject(poseidon([nullifier]));
}

function randomFieldElement(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

interface Note {
  secret: bigint;
  nullifier: bigint;
  commitment: bigint;
  nullifierHash: bigint;
}

function makeNote(): Note {
  const secret = randomFieldElement();
  const nullifier = randomFieldElement();
  return {
    secret,
    nullifier,
    commitment: computeCommitment(secret, nullifier),
    nullifierHash: computeNullifierHash(nullifier),
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployMixerFixture(): Promise<{
  mixer: Mixer;
  signers: Awaited<ReturnType<typeof ethers.getSigners>>;
}> {
  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  const signers = await ethers.getSigners();
  return { mixer, signers };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function depositAndGetRoot(mixer: Mixer, note: Note): Promise<bigint> {
  const [, depositor] = await ethers.getSigners();
  await mixer.connect(depositor).deposit(note.commitment, { value: DENOMINATION });
  return mixer.getLastRoot();
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipientAddr: string
) {
  return mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipientAddr,
    ethers.ZeroAddress,
    0n
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Nullifier Isolation", function () {
  // -------------------------------------------------------------------------
  // 1. Each nullifier is independent — spending one does not affect others
  // -------------------------------------------------------------------------

  it("each nullifier is independent (spending one doesn't affect others)", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);
    const [, depositor, recipient] = signers;

    const noteA = makeNote();
    const noteB = makeNote();

    await mixer.connect(depositor).deposit(noteA.commitment, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(noteB.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    // Spend noteA
    await doWithdraw(mixer, root, noteA.nullifierHash, recipient.address);

    // noteA is spent, noteB is untouched
    expect(await mixer.isSpent(noteA.nullifierHash)).to.be.true;
    expect(await mixer.isSpent(noteB.nullifierHash)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 2. Nullifier not spent before withdrawal
  // -------------------------------------------------------------------------

  it("nullifier not spent before withdrawal", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    const note = makeNote();
    await depositAndGetRoot(mixer, note);

    expect(await mixer.isSpent(note.nullifierHash)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 3. Nullifier is spent after withdrawal
  // -------------------------------------------------------------------------

  it("nullifier is spent after withdrawal", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);
    const [, , recipient] = signers;

    const note = makeNote();
    const root = await depositAndGetRoot(mixer, note);

    await doWithdraw(mixer, root, note.nullifierHash, recipient.address);

    expect(await mixer.isSpent(note.nullifierHash)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 4. Same nullifier cannot be used in two withdrawals (double-spend)
  // -------------------------------------------------------------------------

  it("same nullifier cannot be used in two withdrawals", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);
    const [, , recipient] = signers;

    const note = makeNote();
    const root = await depositAndGetRoot(mixer, note);

    await doWithdraw(mixer, root, note.nullifierHash, recipient.address);

    await expect(
      doWithdraw(mixer, root, note.nullifierHash, recipient.address)
    ).to.be.revertedWith("Mixer: already spent");
  });

  // -------------------------------------------------------------------------
  // 5. Different nullifiers from same depositor both work
  // -------------------------------------------------------------------------

  it("different nullifiers from same depositor both work", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);
    const [, depositor, recipient] = signers;

    const noteA = makeNote();
    const noteB = makeNote();

    await mixer.connect(depositor).deposit(noteA.commitment, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(noteB.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    await doWithdraw(mixer, root, noteA.nullifierHash, recipient.address);
    await doWithdraw(mixer, root, noteB.nullifierHash, recipient.address);

    expect(await mixer.isSpent(noteA.nullifierHash)).to.be.true;
    expect(await mixer.isSpent(noteB.nullifierHash)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 6. isSpent returns false for a random value never used
  // -------------------------------------------------------------------------

  it("isSpent returns false for random value", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    const randomNullifier = randomFieldElement();
    expect(await mixer.isSpent(randomNullifier)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 7. isSpent returns true only after withdrawal with that exact nullifier
  // -------------------------------------------------------------------------

  it("isSpent returns true only after withdrawal with that nullifier", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);
    const [, , recipient] = signers;

    const noteA = makeNote();
    const noteB = makeNote();

    await depositAndGetRoot(mixer, noteA);
    // Deposit noteB but do not withdraw it
    const [, depositor] = signers;
    await mixer.connect(depositor).deposit(noteB.commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    await doWithdraw(mixer, root, noteA.nullifierHash, recipient.address);

    // Only noteA's nullifier should be marked spent
    expect(await mixer.isSpent(noteA.nullifierHash)).to.be.true;
    expect(await mixer.isSpent(noteB.nullifierHash)).to.be.false;
  });

  // -------------------------------------------------------------------------
  // 8. 10 unique nullifiers can all be spent independently
  // -------------------------------------------------------------------------

  it("10 unique nullifiers can all be spent independently", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);
    const depositor = signers[1];
    const recipient = signers[2];

    const notes: Note[] = [];
    for (let i = 0; i < 10; i++) {
      const note = makeNote();
      notes.push(note);
      await mixer.connect(depositor).deposit(note.commitment, { value: DENOMINATION });
    }

    const root = await mixer.getLastRoot();

    for (const note of notes) {
      await doWithdraw(mixer, root, note.nullifierHash, recipient.address);
    }

    for (const note of notes) {
      expect(await mixer.isSpent(note.nullifierHash)).to.be.true;
    }
  });

  // -------------------------------------------------------------------------
  // 9. Nullifier state persists across blocks
  // -------------------------------------------------------------------------

  it("nullifier state persists across blocks", async function () {
    const { mixer, signers } = await loadFixture(deployMixerFixture);
    const [, , recipient] = signers;

    const note = makeNote();
    const root = await depositAndGetRoot(mixer, note);

    await doWithdraw(mixer, root, note.nullifierHash, recipient.address);

    // Mine several blocks
    await ethers.provider.send("hardhat_mine", ["0x64"]); // 100 blocks

    // State must still reflect the spent nullifier
    expect(await mixer.isSpent(note.nullifierHash)).to.be.true;
  });

  // -------------------------------------------------------------------------
  // 10. Nullifier hash is a field element (strictly less than FIELD_SIZE)
  // -------------------------------------------------------------------------

  it("nullifier is a field element (< FIELD_SIZE)", function () {
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) {
      const nullifier = randomFieldElement();
      const nHash = computeNullifierHash(nullifier);
      expect(nHash).to.be.lessThan(FIELD_SIZE);
      expect(nHash).to.be.greaterThan(0n);
    }
  });
});
