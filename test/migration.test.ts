import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

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
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixture — deploys two independent Mixer instances (old and new)
// ---------------------------------------------------------------------------

async function deployTwoMixersFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  // Both instances share the same hasher and verifier bytecode but are
  // deployed at distinct addresses — exactly the "deploy new + migrate" path.
  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const verifierAddress = await verifier.getAddress();

  const MixerFactory = await ethers.getContractFactory("Mixer");

  const oldMixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  const newMixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { oldMixer, newMixer, owner, alice, bob };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Contract Migration", function () {
  // -------------------------------------------------------------------------
  // Fresh state
  // -------------------------------------------------------------------------

  it("new deployment has fresh state (all counters zero)", async function () {
    const { newMixer } = await loadFixture(deployTwoMixersFixture);

    expect(await newMixer.nextIndex()).to.equal(0n);
    expect(await newMixer.totalDeposited()).to.equal(0n);
    expect(await newMixer.totalWithdrawn()).to.equal(0n);
    expect(await newMixer.withdrawalCount()).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // Deployment independence
  // -------------------------------------------------------------------------

  it("old and new deployments are independent (different addresses)", async function () {
    const { oldMixer, newMixer } = await loadFixture(deployTwoMixersFixture);

    const oldAddr = await oldMixer.getAddress();
    const newAddr = await newMixer.getAddress();

    expect(oldAddr).to.not.equal(newAddr);
  });

  it("depositing in old pool does not affect new pool", async function () {
    const { oldMixer, newMixer, alice } = await loadFixture(
      deployTwoMixersFixture
    );

    const commitment = randomCommitment();
    await oldMixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    // Old pool has the deposit
    expect(await oldMixer.nextIndex()).to.equal(1n);
    expect(await oldMixer.commitments(commitment)).to.be.true;

    // New pool is untouched
    expect(await newMixer.nextIndex()).to.equal(0n);
    expect(await newMixer.commitments(commitment)).to.be.false;
  });

  it("nullifier spent in old pool is not spent in new pool", async function () {
    const { oldMixer, newMixer, alice, bob } = await loadFixture(
      deployTwoMixersFixture
    );

    // Deposit in old pool so a valid root exists, then withdraw using a dummy proof.
    // The placeholder verifier accepts any proof so we can drive the state directly.
    const commitment = randomCommitment();
    await oldMixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const root = await oldMixer.getLastRoot();
    const nullifierHash = randomCommitment(); // arbitrary — dummy verifier accepts

    await oldMixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      bob.address,
      ethers.ZeroAddress,
      0n
    );

    expect(await oldMixer.nullifierHashes(nullifierHash)).to.be.true;
    expect(await newMixer.nullifierHashes(nullifierHash)).to.be.false;
  });

  it("old pool can be paused while new pool operates normally", async function () {
    const { oldMixer, newMixer, owner, alice } = await loadFixture(
      deployTwoMixersFixture
    );

    await oldMixer.connect(owner).pause();
    expect(await oldMixer.paused()).to.be.true;
    expect(await newMixer.paused()).to.be.false;

    // Deposit on old pool reverts
    const c1 = randomCommitment();
    await expect(
      oldMixer.connect(alice).deposit(c1, { value: DENOMINATION })
    ).to.be.reverted;

    // Deposit on new pool succeeds
    const c2 = randomCommitment();
    await expect(
      newMixer.connect(alice).deposit(c2, { value: DENOMINATION })
    ).to.emit(newMixer, "Deposit");
  });

  it("commitment from old pool is not known in new pool", async function () {
    const { oldMixer, newMixer, alice } = await loadFixture(
      deployTwoMixersFixture
    );

    const commitment = randomCommitment();
    await oldMixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    expect(await oldMixer.isCommitted(commitment)).to.be.true;
    expect(await newMixer.isCommitted(commitment)).to.be.false;
  });

  it("tree roots are independent between deployments", async function () {
    const { oldMixer, newMixer, alice } = await loadFixture(
      deployTwoMixersFixture
    );

    // Both start with the same empty-tree root
    const initialOldRoot = await oldMixer.getLastRoot();
    const initialNewRoot = await newMixer.getLastRoot();
    expect(initialOldRoot).to.equal(initialNewRoot);

    // After a deposit in the old pool the roots diverge
    await oldMixer
      .connect(alice)
      .deposit(randomCommitment(), { value: DENOMINATION });

    const postDepositOldRoot = await oldMixer.getLastRoot();
    const postDepositNewRoot = await newMixer.getLastRoot();

    expect(postDepositOldRoot).to.not.equal(initialOldRoot);
    expect(postDepositNewRoot).to.equal(initialNewRoot);

    // Old root after deposit is not known in new pool
    expect(await newMixer.isKnownRoot(postDepositOldRoot)).to.be.false;
  });

  it("a root known in old pool is not accepted for withdrawal in new pool", async function () {
    const { oldMixer, newMixer, alice, bob } = await loadFixture(
      deployTwoMixersFixture
    );

    const commitment = randomCommitment();
    await oldMixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const oldRoot = await oldMixer.getLastRoot();
    const nullifierHash = randomCommitment();

    // The old root is not in the new pool's root history
    await expect(
      newMixer.withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        oldRoot,
        nullifierHash,
        bob.address,
        ethers.ZeroAddress,
        0n
      )
    ).to.be.revertedWith("Mixer: unknown root");
  });
});
