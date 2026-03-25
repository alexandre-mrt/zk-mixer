import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const TREE_CAPACITY = 2n ** BigInt(MERKLE_TREE_HEIGHT); // 32
const ONE_DAY = 24 * 60 * 60;

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

async function doDeposit(
  mixer: Mixer,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number]
): Promise<bigint> {
  const c = randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return c;
}

async function doWithdraw(
  mixer: Mixer,
  recipient: { getAddress(): Promise<string> },
  relayer: { getAddress(): Promise<string> },
  nullifierHash: bigint,
  fee = 0n
) {
  const root = await mixer.getLastRoot();
  const recipientAddr = (await recipient.getAddress()) as `0x${string}`;
  const relayerAddr = (await relayer.getAddress()) as `0x${string}`;

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

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function timelockSetMaxDeposits(
  mixer: Mixer,
  owner: Signer,
  max: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setMaxDepositsPerAddress", max]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setMaxDepositsPerAddress(max);
}

// ---------------------------------------------------------------------------
// Fixture
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
  const mixerLens = await MixerLensFactory.deploy();

  return { mixer, mixerLens, owner, depositor, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Getter Consistency
// ---------------------------------------------------------------------------

describe("Getter Consistency", function () {
  // -------------------------------------------------------------------------
  // getStats.depositCount == nextIndex (via getDepositCount)
  // -------------------------------------------------------------------------

  it("getStats.depositCount == nextIndex after 3 deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await doDeposit(mixer, depositor);
    }

    const [, , depositCount] = await mixer.getStats();
    const nextIndex = await mixer.getDepositCount();

    expect(depositCount).to.equal(BigInt(nextIndex));
    expect(depositCount).to.equal(3n);
  });

  // -------------------------------------------------------------------------
  // getStats.withdrawalCount == withdrawalCount()
  // -------------------------------------------------------------------------

  it("getStats.withdrawalCount == storage withdrawalCount after 2 withdrawals", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    await doDeposit(mixer, depositor);
    await doDeposit(mixer, depositor);

    await doWithdraw(mixer, recipient, relayer, randomCommitment());
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const [, , , withdrawalCount] = await mixer.getStats();
    const storedWithdrawalCount = await mixer.withdrawalCount();

    expect(withdrawalCount).to.equal(storedWithdrawalCount);
    expect(withdrawalCount).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // getStats.poolBalance == provider.getBalance(mixer)
  // -------------------------------------------------------------------------

  it("getStats.poolBalance == provider.getBalance(mixer) after deposit and withdrawal", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    await doDeposit(mixer, depositor);
    await doDeposit(mixer, depositor);
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const [, , , , poolBalance] = await mixer.getStats();
    const providerBalance = await ethers.provider.getBalance(await mixer.getAddress());

    expect(poolBalance).to.equal(providerBalance);
    // 2 deposits - 1 withdrawal = 1 denomination
    expect(poolBalance).to.equal(DENOMINATION);
  });

  // -------------------------------------------------------------------------
  // getAnonymitySetSize == getStats.depositCount - getStats.withdrawalCount
  // -------------------------------------------------------------------------

  it("getAnonymitySetSize == depositCount - withdrawalCount from getStats", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    for (let i = 0; i < 4; i++) {
      await doDeposit(mixer, depositor);
    }
    await doWithdraw(mixer, recipient, relayer, randomCommitment());
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const [, , depositCount, withdrawalCount] = await mixer.getStats();
    const anonymitySetSize = await mixer.getAnonymitySetSize();

    expect(anonymitySetSize).to.equal(depositCount - withdrawalCount);
    expect(anonymitySetSize).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // getTreeCapacity == 2^levels
  // -------------------------------------------------------------------------

  it("getTreeCapacity == 2^levels", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const capacity = await mixer.getTreeCapacity();
    const levels = await mixer.levels();

    expect(capacity).to.equal(2n ** levels);
    expect(capacity).to.equal(TREE_CAPACITY);
  });

  // -------------------------------------------------------------------------
  // getTreeUtilization == (nextIndex * 100) / getTreeCapacity
  // -------------------------------------------------------------------------

  it("getTreeUtilization == (nextIndex * 100) / getTreeCapacity after deposits", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    for (let i = 0; i < 4; i++) {
      await doDeposit(mixer, depositor);
    }

    const utilization = await mixer.getTreeUtilization();
    const capacity = await mixer.getTreeCapacity();
    const nextIndex = await mixer.getDepositCount();

    const expectedUtilization = (BigInt(nextIndex) * 100n) / capacity;
    expect(utilization).to.equal(expectedUtilization);
    expect(utilization).to.equal((4n * 100n) / TREE_CAPACITY);
  });

  // -------------------------------------------------------------------------
  // getPoolHealth values match individual getters
  // -------------------------------------------------------------------------

  it("getPoolHealth values match individual getters after 3 deposits + 1 withdrawal", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await doDeposit(mixer, depositor);
    }
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const [anonymitySetSize, treeUtilization, poolBalance, isPaused] =
      await mixer.getPoolHealth();

    expect(anonymitySetSize).to.equal(await mixer.getAnonymitySetSize());
    expect(treeUtilization).to.equal(await mixer.getTreeUtilization());
    expect(poolBalance).to.equal(
      await ethers.provider.getBalance(await mixer.getAddress())
    );
    expect(isPaused).to.equal(await mixer.paused());
  });

  // -------------------------------------------------------------------------
  // MixerLens snapshot matches all individual getters
  // -------------------------------------------------------------------------

  it("MixerLens snapshot matches all individual getters after 3 deposits + 1 withdrawal", async function () {
    const { mixer, mixerLens, depositor, recipient, relayer } = await loadFixture(deployFixture);

    for (let i = 0; i < 3; i++) {
      await doDeposit(mixer, depositor);
    }
    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(snapshot.totalDeposited).to.equal(totalDeposited);
    expect(snapshot.totalWithdrawn).to.equal(totalWithdrawn);
    expect(snapshot.depositCount).to.equal(depositCount);
    expect(snapshot.withdrawalCount).to.equal(withdrawalCount);
    expect(snapshot.poolBalance).to.equal(poolBalance);
    expect(snapshot.anonymitySetSize).to.equal(await mixer.getAnonymitySetSize());
    expect(snapshot.treeCapacity).to.equal(await mixer.getTreeCapacity());
    expect(snapshot.treeUtilization).to.equal(await mixer.getTreeUtilization());
    expect(snapshot.lastRoot).to.equal(await mixer.getLastRoot());
    expect(snapshot.denomination).to.equal(await mixer.denomination());
    expect(snapshot.isPaused).to.equal(await mixer.paused());
    expect(snapshot.maxDepositsPerAddress).to.equal(await mixer.maxDepositsPerAddress());
    expect(snapshot.owner).to.equal(await mixer.owner());
  });

  // -------------------------------------------------------------------------
  // getRemainingDeposits + depositsPerAddress == maxDepositsPerAddress (when set)
  // -------------------------------------------------------------------------

  it("getRemainingDeposits + depositsPerAddress == maxDepositsPerAddress when limit is active", async function () {
    const { mixer, owner, depositor } = await loadFixture(deployFixture);

    const maxDeposits = 5n;
    await timelockSetMaxDeposits(mixer, owner, maxDeposits);

    // Do 2 deposits
    await doDeposit(mixer, depositor);
    await doDeposit(mixer, depositor);

    const remaining = await mixer.getRemainingDeposits(depositor.address);
    const used = await mixer.depositsPerAddress(depositor.address);
    const max = await mixer.maxDepositsPerAddress();

    expect(remaining + used).to.equal(max);
    expect(remaining).to.equal(3n);
    expect(used).to.equal(2n);
  });

  // -------------------------------------------------------------------------
  // hasCapacity == (nextIndex < getTreeCapacity)
  // -------------------------------------------------------------------------

  it("hasCapacity == (nextIndex < getTreeCapacity) before and at capacity", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    // Initially: nextIndex == 0, capacity == 32 → hasCapacity == true
    const capacity = await mixer.getTreeCapacity();
    let nextIndex = await mixer.getDepositCount();
    expect(await mixer.hasCapacity()).to.equal(BigInt(nextIndex) < capacity);
    expect(await mixer.hasCapacity()).to.be.true;

    // After 1 deposit
    await doDeposit(mixer, depositor);
    nextIndex = await mixer.getDepositCount();
    expect(await mixer.hasCapacity()).to.equal(BigInt(nextIndex) < capacity);
    expect(await mixer.hasCapacity()).to.be.true;
  });

  // -------------------------------------------------------------------------
  // getStats totals are consistent across cumulative deposits and withdrawals
  // -------------------------------------------------------------------------

  it("getStats cumulative totals stay consistent across deposit → withdraw → deposit cycle", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    await doDeposit(mixer, depositor);

    let [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();
    expect(totalDeposited).to.equal(DENOMINATION);
    expect(totalWithdrawn).to.equal(0n);
    expect(depositCount).to.equal(1n);
    expect(withdrawalCount).to.equal(0n);
    expect(poolBalance).to.equal(DENOMINATION);

    await doWithdraw(mixer, recipient, relayer, randomCommitment());

    [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();
    expect(totalDeposited).to.equal(DENOMINATION);
    expect(totalWithdrawn).to.equal(DENOMINATION);
    expect(depositCount).to.equal(1n);
    expect(withdrawalCount).to.equal(1n);
    expect(poolBalance).to.equal(0n);

    await doDeposit(mixer, depositor);

    [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();
    expect(totalDeposited).to.equal(DENOMINATION * 2n);
    expect(totalWithdrawn).to.equal(DENOMINATION);
    expect(depositCount).to.equal(2n);
    expect(withdrawalCount).to.equal(1n);
    expect(poolBalance).to.equal(DENOMINATION);

    // Cross-check: poolBalance == totalDeposited - totalWithdrawn
    expect(poolBalance).to.equal(totalDeposited - totalWithdrawn);
  });

  // -------------------------------------------------------------------------
  // getTreeUtilization stays 0 when no deposits
  // -------------------------------------------------------------------------

  it("getTreeUtilization is 0 at deployment and matches formula at all deposit counts", async function () {
    const { mixer, depositor } = await loadFixture(deployFixture);

    expect(await mixer.getTreeUtilization()).to.equal(0n);

    for (let n = 1; n <= 5; n++) {
      await doDeposit(mixer, depositor);
      const utilization = await mixer.getTreeUtilization();
      const expected = (BigInt(n) * 100n) / TREE_CAPACITY;
      expect(utilization).to.equal(expected);
    }
  });

  // -------------------------------------------------------------------------
  // getStats.poolBalance == totalDeposited - totalWithdrawn at all times
  // -------------------------------------------------------------------------

  it("getStats.poolBalance always equals totalDeposited - totalWithdrawn", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    const check = async () => {
      const [totalDeposited, totalWithdrawn, , , poolBalance] = await mixer.getStats();
      expect(poolBalance).to.equal(totalDeposited - totalWithdrawn);
    };

    await check();

    await doDeposit(mixer, depositor);
    await check();

    await doDeposit(mixer, depositor);
    await check();

    await doWithdraw(mixer, recipient, relayer, randomCommitment());
    await check();

    await doDeposit(mixer, depositor);
    await check();

    await doWithdraw(mixer, recipient, relayer, randomCommitment());
    await check();
  });
});
