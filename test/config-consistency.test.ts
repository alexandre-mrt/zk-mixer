import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const EXPECTED_TIMELOCK_DELAY = 86400n; // 1 day in seconds
const EXPECTED_ROOT_HISTORY_SIZE = 30n;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const verifierAddress = await verifier.getAddress();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

  return { mixer, mixerLens, verifierAddress, hasherAddress, owner, alice, bob };
}

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Configuration Consistency Tests
// ---------------------------------------------------------------------------

describe("Configuration Consistency", function () {
  it("VERSION matches across Mixer and MixerLens snapshot", async function () {
    const { mixer, mixerLens } = await loadFixture(deployFixture);

    const mixerVersion = await mixer.VERSION();
    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(mixerVersion).to.equal("1.0.0");
    expect(snapshot.version).to.equal(mixerVersion);
  });

  it("denomination is immutable (same after deposits and withdrawals)", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const denominationBefore = await mixer.denomination();

    // Make several deposits
    for (let i = 0; i < 3; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    // Make a withdrawal (dummy proof accepted by stub verifier)
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();
    await mixer.withdraw(
      [0n, 0n],
      [[0n, 0n], [0n, 0n]],
      [0n, 0n],
      root,
      nullifier,
      bob.address as `0x${string}`,
      ethers.ZeroAddress as `0x${string}`,
      0n
    );

    const denominationAfter = await mixer.denomination();
    expect(denominationAfter).to.equal(denominationBefore);
  });

  it("levels is immutable (same after deposits)", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    const levelsBefore = await mixer.levels();

    for (let i = 0; i < 3; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const levelsAfter = await mixer.levels();
    expect(levelsAfter).to.equal(levelsBefore);
    expect(levelsAfter).to.equal(MERKLE_TREE_HEIGHT);
  });

  it("hasher address is immutable", async function () {
    const { mixer, alice, hasherAddress } = await loadFixture(deployFixture);

    const hasherBefore = await mixer.hasher();
    expect(hasherBefore).to.equal(hasherAddress);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const hasherAfter = await mixer.hasher();
    expect(hasherAfter).to.equal(hasherBefore);
  });

  it("verifier address is immutable", async function () {
    const { mixer, alice, verifierAddress } = await loadFixture(deployFixture);

    const verifierBefore = await mixer.verifier();
    expect(verifierBefore).to.equal(verifierAddress);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const verifierAfter = await mixer.verifier();
    expect(verifierAfter).to.equal(verifierBefore);
  });

  it("deployedChainId is immutable", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    const { chainId } = await ethers.provider.getNetwork();
    const chainIdBefore = await mixer.deployedChainId();
    expect(chainIdBefore).to.equal(chainId);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const chainIdAfter = await mixer.deployedChainId();
    expect(chainIdAfter).to.equal(chainIdBefore);
  });

  it("TIMELOCK_DELAY is exactly 1 day (86400 seconds)", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const timelockDelay = await mixer.TIMELOCK_DELAY();
    expect(timelockDelay).to.equal(EXPECTED_TIMELOCK_DELAY);
  });

  it("ROOT_HISTORY_SIZE is exactly 30", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const rootHistorySize = await mixer.ROOT_HISTORY_SIZE();
    expect(rootHistorySize).to.equal(EXPECTED_ROOT_HISTORY_SIZE);
  });
});
