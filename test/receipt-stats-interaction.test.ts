import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function timelockSetDepositReceipt(
  mixer: Mixer,
  owner: Signer,
  receiptAddress: string
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", receiptAddress]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(24 * 60 * 60 + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

// Perform a withdrawal using a zero proof (verifier accepts anything in tests)
async function doWithdraw(
  mixer: Mixer,
  recipient: Signer,
  relayer: Signer,
  nullifierHash: bigint,
  fee = 0n
) {
  const root = await mixer.getLastRoot();
  const recipientAddr = (await recipient.getAddress()) as `0x${string}`;
  const relayerAddr = (await relayer.getAddress()) as `0x${string}`;

  const ZERO_PROOF = {
    pA: [0n, 0n] as [bigint, bigint],
    pB: [
      [0n, 0n],
      [0n, 0n],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [0n, 0n] as [bigint, bigint],
  };

  return mixer.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifierHash,
    recipientAddr,
    relayerAddr,
    fee
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = await MixerLensFactory.deploy();

  return { mixer, receipt, mixerLens, owner, depositor, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Receipt and Stats Interactions", function () {
  // -------------------------------------------------------------------------
  // Receipt + stats
  // -------------------------------------------------------------------------

  it("deposit receipt count matches getStats depositCount", async function () {
    const { mixer, receipt, depositor } = await loadFixture(deployFixture);

    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

    const [, , depositCount] = await mixer.getStats();
    const receiptBalance = await receipt.balanceOf(await depositor.getAddress());

    expect(receiptBalance).to.equal(depositCount);
    expect(receiptBalance).to.equal(3n);
  });

  it("receipt tokenId sequence matches deposit order", async function () {
    const { mixer, receipt, depositor } = await loadFixture(deployFixture);

    const c0 = randomCommitment();
    const c1 = randomCommitment();
    const c2 = randomCommitment();

    await mixer.connect(depositor).deposit(c0, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c2, { value: DENOMINATION });

    // TokenIds are assigned sequentially starting at 0
    expect(await receipt.tokenCommitment(0n)).to.equal(c0);
    expect(await receipt.tokenCommitment(1n)).to.equal(c1);
    expect(await receipt.tokenCommitment(2n)).to.equal(c2);
  });

  it("receipt commitment matches getCommitmentIndex", async function () {
    const { mixer, receipt, depositor } = await loadFixture(deployFixture);

    const c0 = randomCommitment();
    const c1 = randomCommitment();

    await mixer.connect(depositor).deposit(c0, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(c1, { value: DENOMINATION });

    // tokenId matches the Merkle tree leaf index because both are sequential
    const leafIndex0 = await mixer.getCommitmentIndex(c0);
    const leafIndex1 = await mixer.getCommitmentIndex(c1);

    expect(await receipt.tokenCommitment(BigInt(leafIndex0))).to.equal(c0);
    expect(await receipt.tokenCommitment(BigInt(leafIndex1))).to.equal(c1);
  });

  // -------------------------------------------------------------------------
  // Stats after complex operations
  // -------------------------------------------------------------------------

  it("getStats reflects 10 deposits + 5 withdrawals correctly", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    for (let i = 0; i < 10; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }
    for (let i = 0; i < 5; i++) {
      await doWithdraw(mixer, recipient, relayer, randomCommitment());
    }

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(depositCount).to.equal(10n);
    expect(withdrawalCount).to.equal(5n);
    expect(totalDeposited).to.equal(DENOMINATION * 10n);
    expect(totalWithdrawn).to.equal(DENOMINATION * 5n);
    expect(poolBalance).to.equal(DENOMINATION * 5n);
  });

  it("anonymitySetSize + withdrawalCount == depositCount", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    for (let i = 0; i < 7; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }
    for (let i = 0; i < 3; i++) {
      await doWithdraw(mixer, recipient, relayer, randomCommitment());
    }

    const [, , depositCount, withdrawalCount] = await mixer.getStats();
    const anonymitySetSize = await mixer.getAnonymitySetSize();

    expect(anonymitySetSize + withdrawalCount).to.equal(depositCount);
    expect(anonymitySetSize).to.equal(4n);
  });

  it("totalDeposited == depositCount * denomination", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const count = 6n;
    for (let i = 0; i < count; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const [totalDeposited, , depositCount] = await mixer.getStats();

    expect(totalDeposited).to.equal(depositCount * DENOMINATION);
    expect(totalDeposited).to.equal(count * DENOMINATION);
  });

  it("totalWithdrawn == withdrawalCount * denomination", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }
    for (let i = 0; i < 3; i++) {
      await doWithdraw(mixer, recipient, relayer, randomCommitment());
    }

    const [, totalWithdrawn, , withdrawalCount] = await mixer.getStats();

    expect(totalWithdrawn).to.equal(withdrawalCount * DENOMINATION);
    expect(totalWithdrawn).to.equal(3n * DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // Lens snapshot consistency after operations
  // -------------------------------------------------------------------------

  it("MixerLens snapshot correct after 3 deposits", async function () {
    const { mixer, mixerLens, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.depositCount).to.equal(3n);
    expect(snapshot.withdrawalCount).to.equal(0n);
    expect(snapshot.totalDeposited).to.equal(DENOMINATION * 3n);
    expect(snapshot.totalWithdrawn).to.equal(0n);
    expect(snapshot.poolBalance).to.equal(DENOMINATION * 3n);
    expect(snapshot.anonymitySetSize).to.equal(3n);
    expect(snapshot.treeUtilization).to.equal((3n * 100n) / TREE_CAPACITY);
  });

  it("MixerLens snapshot correct after 3 deposits + 1 withdrawal", async function () {
    const { mixer, mixerLens, depositor, recipient, relayer } =
      await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    expect(snapshot.depositCount).to.equal(3n);
    expect(snapshot.withdrawalCount).to.equal(1n);
    expect(snapshot.totalDeposited).to.equal(DENOMINATION * 3n);
    expect(snapshot.totalWithdrawn).to.equal(DENOMINATION);
    expect(snapshot.poolBalance).to.equal(DENOMINATION * 2n);
    expect(snapshot.anonymitySetSize).to.equal(2n);
  });

  it("MixerLens snapshot correct after pause", async function () {
    const { mixer, mixerLens, owner, depositor } = await loadFixture(deployFixture);

    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

    const mixerAddress = await mixer.getAddress();

    const beforePause = await mixerLens.getSnapshot(mixerAddress);
    expect(beforePause.isPaused).to.equal(false);
    expect(beforePause.depositCount).to.equal(1n);

    await mixer.connect(owner).pause();

    const afterPause = await mixerLens.getSnapshot(mixerAddress);
    expect(afterPause.isPaused).to.equal(true);
    // Stats must not change upon pause
    expect(afterPause.depositCount).to.equal(1n);
    expect(afterPause.totalDeposited).to.equal(DENOMINATION);
    expect(afterPause.poolBalance).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // Pool health monitoring
  // -------------------------------------------------------------------------

  it("getPoolHealth returns correct utilization at 50% capacity", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    // Fill exactly half of the tree (capacity = 32, so 16 deposits)
    const halfCapacity = Number(TREE_CAPACITY) / 2;
    for (let i = 0; i < halfCapacity; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.getPoolHealth();

    expect(treeUtilization).to.equal(50n); // (16 * 100) / 32 = 50
    expect(anonymitySetSize).to.equal(BigInt(halfCapacity));
    expect(poolBalance).to.equal(DENOMINATION * BigInt(halfCapacity));
    expect(isPaused).to.equal(false);
  });

  it("getPoolHealth reflects anonymity set growth", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    // Initial state: empty pool
    let [anonymitySetSize] = await mixer.getPoolHealth();
    expect(anonymitySetSize).to.equal(0n);

    // After 4 deposits
    for (let i = 0; i < 4; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }
    [anonymitySetSize] = await mixer.getPoolHealth();
    expect(anonymitySetSize).to.equal(4n);

    // After 2 withdrawals: anonymity set shrinks
    await doWithdraw(mixer, recipient, relayer, randomCommitment());
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    [anonymitySetSize] = await mixer.getPoolHealth();
    expect(anonymitySetSize).to.equal(2n);

    // After 1 more deposit: grows again
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    [anonymitySetSize] = await mixer.getPoolHealth();
    expect(anonymitySetSize).to.equal(3n);
  });
});
