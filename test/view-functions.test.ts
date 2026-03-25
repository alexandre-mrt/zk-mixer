import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const EXPECTED_TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32
const ROOT_HISTORY_SIZE = 30;
const TIMELOCK_DELAY_SECONDS = 86_400n; // 1 day
const HARDHAT_CHAIN_ID = 31337n;
const UINT256_MAX = 2n ** 256n - 1n;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, depositor] = await ethers.getSigners();

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

  return { mixer, owner, depositor };
}

// ---------------------------------------------------------------------------
// View Functions — initial state
// ---------------------------------------------------------------------------

describe("View Functions", function () {
  it("denomination returns 0.1 ETH", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const value = await mixer.denomination();
    expect(typeof value).to.equal("bigint");
    expect(value).to.equal(DENOMINATION);
  });

  it("levels returns configured tree height", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const value = await mixer.levels();
    expect(typeof value).to.equal("bigint");
    expect(value).to.equal(BigInt(MERKLE_TREE_HEIGHT));
  });

  it("getLastRoot returns non-zero after deployment", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const root = await mixer.getLastRoot();
    expect(typeof root).to.equal("bigint");
    expect(root).to.be.greaterThan(0n);
  });

  it("isKnownRoot(getLastRoot()) returns true", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const root = await mixer.getLastRoot();
    const known = await mixer.isKnownRoot(root);
    expect(typeof known).to.equal("boolean");
    expect(known).to.be.true;
  });

  it("isKnownRoot(0) returns false", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const known = await mixer.isKnownRoot(0n);
    expect(typeof known).to.equal("boolean");
    expect(known).to.be.false;
  });

  it("getStats returns 5 values all initially zero except balance", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(totalDeposited).to.equal(0n);
    expect(totalWithdrawn).to.equal(0n);
    expect(depositCount).to.equal(0n);
    expect(withdrawalCount).to.equal(0n);
    // Balance is 0 initially — no ETH sent to contract at deploy
    expect(poolBalance).to.equal(0n);

    // All 5 are bigint
    for (const v of [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance]) {
      expect(typeof v).to.equal("bigint");
    }
  });

  it("getAnonymitySetSize returns 0 initially", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const size = await mixer.getAnonymitySetSize();
    expect(typeof size).to.equal("bigint");
    expect(size).to.equal(0n);
  });

  it("getPoolHealth returns 4 values", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.getPoolHealth();

    expect(typeof anonymitySetSize).to.equal("bigint");
    expect(typeof treeUtilization).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
    expect(typeof isPaused).to.equal("boolean");

    expect(anonymitySetSize).to.equal(0n);
    expect(treeUtilization).to.equal(0n);
    expect(poolBalance).to.equal(0n);
    expect(isPaused).to.be.false;
  });

  it("getTreeCapacity returns 2^levels", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const capacity = await mixer.getTreeCapacity();
    expect(typeof capacity).to.equal("bigint");
    expect(capacity).to.equal(EXPECTED_TREE_CAPACITY);
  });

  it("getTreeUtilization returns 0 initially", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const utilization = await mixer.getTreeUtilization();
    expect(typeof utilization).to.equal("bigint");
    expect(utilization).to.equal(0n);
    expect(utilization).to.be.lessThanOrEqual(100n);
  });

  it("hasCapacity returns true initially", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const capacity = await mixer.hasCapacity();
    expect(typeof capacity).to.equal("boolean");
    expect(capacity).to.be.true;
  });

  it("getRootHistory returns array of length 30", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const history = await mixer.getRootHistory();
    expect(Array.isArray(history)).to.be.true;
    expect(history.length).to.equal(ROOT_HISTORY_SIZE);
    // Every entry should be a bigint
    for (const root of history) {
      expect(typeof root).to.equal("bigint");
    }
  });

  it("getValidRootCount returns 1 initially (empty tree root)", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const count = await mixer.getValidRootCount();
    expect(typeof count).to.equal("bigint");
    // The constructor places the empty-tree root at roots[0]. That is the
    // only non-zero slot before any deposit occurs.
    expect(count).to.equal(1n);
  });

  it("getRemainingDeposits returns max uint when limit is 0", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    // maxDepositsPerAddress defaults to 0 (unlimited)
    const remaining = await mixer.getRemainingDeposits(depositor.address);
    expect(typeof remaining).to.equal("bigint");
    expect(remaining).to.equal(UINT256_MAX);
  });

  it("deployedChainId returns 31337", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const chainId = await mixer.deployedChainId();
    expect(typeof chainId).to.equal("bigint");
    expect(chainId).to.equal(HARDHAT_CHAIN_ID);
  });

  it("TIMELOCK_DELAY returns 86400 (1 day)", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const delay = await mixer.TIMELOCK_DELAY();
    expect(typeof delay).to.equal("bigint");
    expect(delay).to.equal(TIMELOCK_DELAY_SECONDS);
  });

  it("paused returns false initially", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const paused = await mixer.paused();
    expect(typeof paused).to.equal("boolean");
    expect(paused).to.be.false;
  });

  it("owner returns deployer", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    const contractOwner = await mixer.owner();
    expect(typeof contractOwner).to.equal("string");
    expect(contractOwner).to.equal(owner.address);
  });
});
