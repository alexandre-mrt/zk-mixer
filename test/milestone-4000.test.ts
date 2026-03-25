import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

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
// Fixtures
// ---------------------------------------------------------------------------

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

  return { mixer, mixerLens, owner, depositor, recipient, relayer };
}

async function deployWithReceiptFixture() {
  const { mixer, mixerLens, owner, depositor, recipient, relayer } =
    await deployFixture();

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  const receiptAddress = await receipt.getAddress();
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", receiptAddress]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
  await ethers.provider.send("evm_mine", []);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);

  return { mixer, mixerLens, receipt, owner, depositor, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Milestone Tests
// ---------------------------------------------------------------------------

describe("Milestone Tests", function () {
  it("fresh deployment: all stats are zero", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const [
      totalDeposited,
      totalWithdrawn,
      depositCount,
      withdrawalCount,
      poolBalance,
    ] = await mixer.getStats();

    expect(totalDeposited).to.equal(0n);
    expect(totalWithdrawn).to.equal(0n);
    expect(depositCount).to.equal(0n);
    expect(withdrawalCount).to.equal(0n);
    expect(poolBalance).to.equal(0n);
  });

  it("first deposit changes state correctly", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    const commitment = randomCommitment();

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const [totalDeposited, , depositCount, , poolBalance] =
      await mixer.getStats();

    expect(totalDeposited).to.equal(DENOMINATION);
    expect(depositCount).to.equal(1n);
    expect(poolBalance).to.equal(DENOMINATION);
    expect(await mixer.getAnonymitySetSize()).to.equal(1n);
    expect(await mixer.commitments(commitment)).to.be.true;
  });

  it("first withdrawal changes state correctly", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();

    await mixer.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifierHash,
      (await recipient.getAddress()) as `0x${string}`,
      (await relayer.getAddress()) as `0x${string}`,
      0n
    );

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount] =
      await mixer.getStats();

    expect(totalDeposited).to.equal(DENOMINATION);
    expect(totalWithdrawn).to.equal(DENOMINATION);
    expect(depositCount).to.equal(1n);
    expect(withdrawalCount).to.equal(1n);
  });

  it("pool health at 0 deposits", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.getPoolHealth();

    expect(anonymitySetSize).to.equal(0n);
    expect(treeUtilization).to.equal(0n);
    expect(poolBalance).to.equal(0n);
    expect(isPaused).to.be.false;
  });

  it("pool health at 1 deposit", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    await mixer
      .connect(depositor)
      .deposit(randomCommitment(), { value: DENOMINATION });

    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.getPoolHealth();

    expect(anonymitySetSize).to.equal(1n);
    expect(treeUtilization).to.equal((1n * 100n) / TREE_CAPACITY);
    expect(poolBalance).to.equal(DENOMINATION);
    expect(isPaused).to.be.false;
  });

  it("pool health at 5 deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      await mixer
        .connect(depositor)
        .deposit(randomCommitment(), { value: DENOMINATION });
    }

    const [anonymitySetSize, treeUtilization, poolBalance] =
      await mixer.getPoolHealth();

    expect(anonymitySetSize).to.equal(5n);
    expect(treeUtilization).to.equal((5n * 100n) / TREE_CAPACITY);
    expect(poolBalance).to.equal(DENOMINATION * 5n);
  });

  it("lens snapshot empty pool", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);
    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(snapshot.depositCount).to.equal(0n);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.totalDeposited).to.equal(0n);
    expect(snapshot.poolBalance).to.equal(0n);
    expect(snapshot.anonymitySetSize).to.equal(0n);
    expect(snapshot.denomination).to.equal(DENOMINATION);
    expect(snapshot.isPaused).to.be.false;
    expect(snapshot.owner).to.equal(await owner.getAddress());
    expect(snapshot.lastRoot).to.be.greaterThan(0n);
  });

  it("lens snapshot after deposit", async function () {
    const { mixer, mixerLens, depositor } = await loadFixture(deployFixture);
    await mixer
      .connect(depositor)
      .deposit(randomCommitment(), { value: DENOMINATION });

    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(snapshot.depositCount).to.equal(1n);
    expect(snapshot.totalDeposited).to.equal(DENOMINATION);
    expect(snapshot.poolBalance).to.equal(DENOMINATION);
    expect(snapshot.anonymitySetSize).to.equal(1n);
    expect(snapshot.treeUtilization).to.equal(
      (1n * 100n) / TREE_CAPACITY
    );
  });

  it("receipt mints on first deposit", async function () {
    const { mixer, receipt, depositor } =
      await loadFixture(deployWithReceiptFixture);

    expect(await receipt.balanceOf(await depositor.getAddress())).to.equal(0n);

    await mixer
      .connect(depositor)
      .deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.balanceOf(await depositor.getAddress())).to.equal(1n);
  });

  it("hash(0,0) is consistent across calls", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const first = await mixer.hashLeftRight(0n, 0n);
    const second = await mixer.hashLeftRight(0n, 0n);

    expect(first).to.equal(second);
    expect(first).to.be.greaterThan(0n);
  });

  it("commitment 42 accepted", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    await expect(
      mixer.connect(depositor).deposit(42n, { value: DENOMINATION })
    ).to.emit(mixer, "Deposit");

    expect(await mixer.commitments(42n)).to.be.true;
  });

  it("getCommitments(0,0) returns empty", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);
    await mixer
      .connect(depositor)
      .deposit(randomCommitment(), { value: DENOMINATION });

    const result = await mixer.getCommitments(0, 0);
    expect(result.length).to.equal(0);
  });
});
