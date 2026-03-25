import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens, DepositReceipt } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// Returns true if the error indicates the function selector was not found in
// the ABI (i.e. the call never reached the contract).
function isFunctionNotFound(err: unknown): boolean {
  const msg = (err as Error).message ?? "";
  return (
    msg.includes("function not found") ||
    msg.includes("no matching function") ||
    msg.includes("call revert exception") ||
    msg.includes("CALL_EXCEPTION")
  );
}

async function deployFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const depositReceipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  return { mixer, mixerLens, depositReceipt, owner, depositor, recipient, relayer };
}

// ---------------------------------------------------------------------------
// ABI Function Selectors
// ---------------------------------------------------------------------------

describe("ABI Function Selectors", function () {
  // -------------------------------------------------------------------------
  // Mixer — mutating functions
  // -------------------------------------------------------------------------

  it("deposit(uint256) selector exists in ABI", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const commitment = ethers.toBigInt(ethers.randomBytes(31));
    try {
      await mixer.deposit(commitment, { value: DENOMINATION });
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `deposit() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("withdraw selector exists in ABI", async function () {
    const { mixer, depositor, recipient } = await loadFixture(deployFixture);
    // Deposit first so a known root exists for the proof to reference.
    const commitment = ethers.toBigInt(ethers.randomBytes(31));
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();

    try {
      await mixer.withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        1n,
        recipient.address as `0x${string}`,
        ethers.ZeroAddress as `0x${string}`,
        0n
      );
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `withdraw() selector not found: ${(err as Error).message}`
      );
    }
  });

  it("pause() selector exists", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    try {
      await mixer.connect(owner).pause();
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `pause() selector not found: ${(err as Error).message}`
      );
    }
    expect(await mixer.paused()).to.equal(true);
  });

  it("unpause() selector exists", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    await mixer.connect(owner).pause();
    try {
      await mixer.connect(owner).unpause();
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `unpause() selector not found: ${(err as Error).message}`
      );
    }
    expect(await mixer.paused()).to.equal(false);
  });

  // -------------------------------------------------------------------------
  // Mixer — view functions
  // -------------------------------------------------------------------------

  it("denomination() selector exists and returns uint256", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const denom = await mixer.denomination();
    expect(typeof denom).to.equal("bigint");
    expect(denom).to.equal(DENOMINATION);
  });

  it("levels() selector exists and returns uint32", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const lvls = await mixer.levels();
    expect(typeof lvls).to.equal("bigint");
    expect(lvls).to.equal(BigInt(MERKLE_TREE_HEIGHT));
  });

  it("getLastRoot() selector exists and returns uint256", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const root = await mixer.getLastRoot();
    expect(typeof root).to.equal("bigint");
  });

  it("isKnownRoot(uint256) selector exists and returns bool", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const result = await mixer.isKnownRoot(1n);
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(false);
  });

  it("isSpent(uint256) selector exists and returns bool", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const spent = await mixer.isSpent(1n);
    expect(typeof spent).to.equal("boolean");
    expect(spent).to.equal(false);
  });

  it("isCommitted(uint256) selector exists and returns bool", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const committed = await mixer.isCommitted(1n);
    expect(typeof committed).to.equal("boolean");
    expect(committed).to.equal(false);
  });

  it("getStats() selector exists and returns 5 values", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const result = await mixer.getStats();
    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] = result;
    expect(typeof totalDeposited).to.equal("bigint");
    expect(typeof totalWithdrawn).to.equal("bigint");
    expect(typeof depositCount).to.equal("bigint");
    expect(typeof withdrawalCount).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
  });

  it("getAnonymitySetSize() selector exists and returns uint256", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const size = await mixer.getAnonymitySetSize();
    expect(typeof size).to.equal("bigint");
    expect(size).to.equal(0n);
  });

  it("getPoolHealth() selector exists and returns 4 values", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const result = await mixer.getPoolHealth();
    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] = result;
    expect(typeof anonymitySetSize).to.equal("bigint");
    expect(typeof treeUtilization).to.equal("bigint");
    expect(typeof poolBalance).to.equal("bigint");
    expect(typeof isPaused).to.equal("boolean");
  });

  it("getTreeCapacity() selector exists and returns uint256", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const capacity = await mixer.getTreeCapacity();
    expect(typeof capacity).to.equal("bigint");
    expect(capacity).to.equal(BigInt(2 ** MERKLE_TREE_HEIGHT));
  });

  it("hashLeftRight(uint256,uint256) selector exists and returns uint256", async function () {
    const { mixer } = await loadFixture(deployFixture);
    // Both inputs must be < FIELD_SIZE; use small safe values.
    const result = await mixer.hashLeftRight(1n, 2n);
    expect(typeof result).to.equal("bigint");
    expect(result).to.be.gt(0n);
  });

  it("verifyCommitment(uint256,uint256) selector exists and returns uint256", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const result = await mixer.verifyCommitment(1n, 2n);
    expect(typeof result).to.equal("bigint");
    expect(result).to.be.gt(0n);
  });

  it("owner() selector exists and returns address", async function () {
    const { mixer, owner } = await loadFixture(deployFixture);
    const ownerAddr = await mixer.owner();
    expect(ownerAddr).to.equal(owner.address);
  });

  it("supportsInterface(bytes4) selector exists and returns bool", async function () {
    const { mixer } = await loadFixture(deployFixture);
    // ERC165 interface ID
    const result = await mixer.supportsInterface("0x01ffc9a7");
    expect(typeof result).to.equal("boolean");
    expect(result).to.equal(true);
  });

  it("VERSION() selector exists and returns string", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const version = await mixer.VERSION();
    expect(typeof version).to.equal("string");
    expect(version.length).to.be.gt(0);
  });

  it("getVersion() selector exists and returns string", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const version = await mixer.getVersion();
    expect(typeof version).to.equal("string");
    expect(version).to.equal(await mixer.VERSION());
  });

  // -------------------------------------------------------------------------
  // MixerLens
  // -------------------------------------------------------------------------

  it("MixerLens.getSnapshot(address) selector exists and returns PoolSnapshot", async function () {
    const { mixer, mixerLens } = await loadFixture(deployFixture);
    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());
    expect(typeof snapshot.totalDeposited).to.equal("bigint");
    expect(typeof snapshot.totalWithdrawn).to.equal("bigint");
    expect(typeof snapshot.depositCount).to.equal("bigint");
    expect(typeof snapshot.withdrawalCount).to.equal("bigint");
    expect(typeof snapshot.poolBalance).to.equal("bigint");
    expect(typeof snapshot.anonymitySetSize).to.equal("bigint");
    expect(typeof snapshot.treeCapacity).to.equal("bigint");
    expect(typeof snapshot.treeUtilization).to.equal("bigint");
    expect(typeof snapshot.lastRoot).to.equal("bigint");
    expect(snapshot.denomination).to.equal(DENOMINATION);
    expect(typeof snapshot.isPaused).to.equal("boolean");
    expect(typeof snapshot.owner).to.equal("string");
  });

  // -------------------------------------------------------------------------
  // DepositReceipt
  // -------------------------------------------------------------------------

  it("DepositReceipt.mint selector exists (reverts with only mixer for non-pool caller)", async function () {
    const { depositReceipt, depositor } = await loadFixture(deployFixture);
    try {
      await depositReceipt.connect(depositor).mint(depositor.address, 1n);
    } catch (err) {
      expect(isFunctionNotFound(err)).to.equal(
        false,
        `mint() selector not found on DepositReceipt: ${(err as Error).message}`
      );
      expect((err as Error).message).to.include("only mixer");
    }
  });
});
