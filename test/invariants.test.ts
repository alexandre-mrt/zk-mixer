import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function deployFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

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

  return { mixer, verifier, owner, alice, bob, relayer };
}

async function doDeposit(mixer: Mixer, signer: Signer, commitment?: bigint) {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return { commitment: c };
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipient: Signer,
  relayerAddr: string = ZERO_ADDRESS,
  fee: bigint = 0n
) {
  return mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipient.address as `0x${string}`,
    relayerAddr as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// System Invariants
// ---------------------------------------------------------------------------

describe("System Invariants", function () {
  // Invariant 1: pool balance == (depositCount - withdrawalCount) * denomination
  it("pool balance always equals (depositCount - withdrawalCount) * denomination", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);
    const denom = await mixer.denomination();

    for (let i = 0; i < 5; i++) {
      await doDeposit(mixer, alice);
    }

    for (let i = 0; i < 2; i++) {
      const root = await mixer.getLastRoot();
      const nullifier = randomCommitment();
      await doWithdraw(mixer, root, nullifier, bob);
    }

    const [, , depCount, withCount, balance] = await mixer.getStats();
    expect(balance).to.equal((depCount - withCount) * denom);
  });

  // Invariant 2: nullifier uniqueness — a spent nullifier cannot be used again
  it("no nullifier can be used twice", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    await doDeposit(mixer, alice);
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();

    // First withdrawal succeeds
    await doWithdraw(mixer, root, nullifier, bob);
    expect(await mixer.isSpent(nullifier)).to.be.true;

    // Second withdrawal with the same nullifier must revert
    await expect(
      doWithdraw(mixer, root, nullifier, bob)
    ).to.be.revertedWith("Mixer: already spent");
  });

  // Invariant 3: commitment uniqueness — same commitment cannot be deposited twice
  it("no commitment can be deposited twice", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await doDeposit(mixer, alice, commitment);

    await expect(
      doDeposit(mixer, alice, commitment)
    ).to.be.revertedWith("Mixer: duplicate commitment");
  });

  // Invariant 4: nextIndex is monotonically increasing
  it("nextIndex always increases and never decreases", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const indices: bigint[] = [];
    indices.push(await mixer.nextIndex());

    for (let i = 0; i < 4; i++) {
      await doDeposit(mixer, alice);
      indices.push(await mixer.nextIndex());
    }

    // Perform a withdrawal and confirm nextIndex does not decrease
    const root = await mixer.getLastRoot();
    await doWithdraw(mixer, root, randomCommitment(), bob);
    indices.push(await mixer.nextIndex());

    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).to.be.gte(indices[i - 1], `nextIndex decreased at step ${i}`);
    }

    // After deposits, nextIndex must have strictly increased
    expect(indices[4]).to.be.gt(indices[0]);
  });

  // Invariant 5: every root that was ever current is in the history (within window)
  it("every root that was ever current is in the history (within window)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    // Collect roots after each deposit (within ROOT_HISTORY_SIZE = 30)
    const observedRoots: bigint[] = [];
    observedRoots.push(await mixer.getLastRoot());

    for (let i = 0; i < 5; i++) {
      await doDeposit(mixer, alice);
      observedRoots.push(await mixer.getLastRoot());
    }

    // All observed roots must be recognized as known
    for (const root of observedRoots) {
      expect(await mixer.isKnownRoot(root)).to.be.true;
    }
  });

  // Invariant 6: totalDeposited >= totalWithdrawn at all times
  it("totalDeposited is always >= totalWithdrawn", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    // Check before any operations
    {
      const [dep, wit] = await mixer.getStats();
      expect(dep).to.be.gte(wit);
    }

    // After 3 deposits
    for (let i = 0; i < 3; i++) {
      await doDeposit(mixer, alice);
    }
    {
      const [dep, wit] = await mixer.getStats();
      expect(dep).to.be.gte(wit);
    }

    // After 2 withdrawals
    for (let i = 0; i < 2; i++) {
      const root = await mixer.getLastRoot();
      await doWithdraw(mixer, root, randomCommitment(), bob);
    }
    {
      const [dep, wit] = await mixer.getStats();
      expect(dep).to.be.gte(wit);
    }
  });

  // Invariant 7: anonymitySetSize never goes negative
  it("anonymitySetSize never goes negative", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    expect(await mixer.getAnonymitySetSize()).to.equal(0n);

    for (let i = 0; i < 3; i++) {
      await doDeposit(mixer, alice);
      expect(await mixer.getAnonymitySetSize()).to.be.gte(0n);
    }

    for (let i = 0; i < 3; i++) {
      const root = await mixer.getLastRoot();
      await doWithdraw(mixer, root, randomCommitment(), bob);
      expect(await mixer.getAnonymitySetSize()).to.be.gte(0n);
    }
  });

  // Invariant 8: 10 random deposits + 5 random withdrawals maintain all invariants
  it("10 random deposits + 5 random withdrawals maintain all invariants", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const denom = await mixer.denomination();
    const usedNullifiers = new Set<bigint>();

    for (let i = 0; i < 10; i++) {
      await doDeposit(mixer, alice);
    }

    for (let i = 0; i < 5; i++) {
      const root = await mixer.getLastRoot();
      let nullifier: bigint;
      do {
        nullifier = randomCommitment();
      } while (usedNullifiers.has(nullifier));
      usedNullifiers.add(nullifier);

      await doWithdraw(mixer, root, nullifier, bob);
    }

    const [totalDep, totalWith, depCount, withCount, balance] = await mixer.getStats();

    // Invariant: balance == (deposits - withdrawals) * denomination
    expect(balance).to.equal((depCount - withCount) * denom);

    // Invariant: totalDeposited >= totalWithdrawn
    expect(totalDep).to.be.gte(totalWith);

    // Invariant: anonymitySetSize >= 0
    expect(await mixer.getAnonymitySetSize()).to.be.gte(0n);

    // Invariant: depositCount == nextIndex
    expect(await mixer.nextIndex()).to.equal(depCount);

    // Invariant: all used nullifiers are marked spent
    for (const nullifier of usedNullifiers) {
      expect(await mixer.isSpent(nullifier)).to.be.true;
    }
  });
});
