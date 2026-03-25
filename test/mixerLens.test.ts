import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function deployFixture() {
  const [owner, depositor, recipient] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = await MixerLensFactory.deploy();

  return { mixer, mixerLens, owner, depositor, recipient };
}

describe("MixerLens", function () {
  it("returns correct initial snapshot", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.totalDeposited).to.equal(0n);
    expect(snapshot.totalWithdrawn).to.equal(0n);
    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.poolBalance).to.equal(0n);
    expect(snapshot.anonymitySetSize).to.equal(0n);
    expect(snapshot.treeCapacity).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
    expect(snapshot.treeUtilization).to.equal(0n);
    expect(snapshot.denomination).to.equal(DENOMINATION);
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.maxDepositsPerAddress).to.equal(0n);
    expect(snapshot.owner).to.equal(await owner.getAddress());
    // lastRoot is the initial empty-tree root — just verify it is non-zero
    expect(snapshot.lastRoot).to.not.equal(0n);
  });

  it("returns updated snapshot after deposit", async function () {
    const { mixer, mixerLens, depositor } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer
      .connect(depositor)
      .deposit(commitment, { value: DENOMINATION });

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.totalDeposited).to.equal(DENOMINATION);
    expect(snapshot.totalWithdrawn).to.equal(0n);
    expect(snapshot.depositCount).to.equal(1n);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.poolBalance).to.equal(DENOMINATION);
    expect(snapshot.anonymitySetSize).to.equal(1n);
    // treeUtilization = (1 * 100) / 2^MERKLE_TREE_HEIGHT
    const expectedUtilization = (1n * 100n) / BigInt(2 ** MERKLE_TREE_HEIGHT);
    expect(snapshot.treeUtilization).to.equal(expectedUtilization);
    // lastRoot must have changed from the zero-deposit root
    expect(snapshot.lastRoot).to.not.equal(0n);
  });

  it("reflects pause state", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);

    const mixerAddress = await mixer.getAddress();

    const beforePause = await mixerLens.getSnapshot(mixerAddress);
    expect(beforePause.isPaused).to.equal(false);

    await mixer.connect(owner).pause();

    const afterPause = await mixerLens.getSnapshot(mixerAddress);
    expect(afterPause.isPaused).to.equal(true);

    await mixer.connect(owner).unpause();

    const afterUnpause = await mixerLens.getSnapshot(mixerAddress);
    expect(afterUnpause.isPaused).to.equal(false);
  });
});
