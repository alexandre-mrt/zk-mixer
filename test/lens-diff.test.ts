import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;
const TREE_CAPACITY = BigInt(2 ** MERKLE_TREE_HEIGHT); // 32

// Dummy proof values — the placeholder verifier always returns true
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
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

function randomNullifierHash(): bigint {
  return BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")) + 1n;
}

function maxDepositsActionHash(max: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], ["setMaxDepositsPerAddress", max])
  );
}

// ---------------------------------------------------------------------------
// Snapshot diff utility
// ---------------------------------------------------------------------------

type MixerSnapshotFields = {
  totalDeposited: bigint;
  totalWithdrawn: bigint;
  depositCount: bigint;
  withdrawalCount: bigint;
  poolBalance: bigint;
  anonymitySetSize: bigint;
  treeCapacity: bigint;
  treeUtilization: bigint;
  lastRoot: bigint;
  denomination: bigint;
  isPaused: boolean;
  maxDepositsPerAddress: bigint;
  owner: string;
  version: string;
};

type SnapshotDiff = {
  changed: (keyof MixerSnapshotFields)[];
  unchanged: (keyof MixerSnapshotFields)[];
};

function diffSnapshots(
  before: MixerSnapshotFields,
  after: MixerSnapshotFields
): SnapshotDiff {
  const keys = Object.keys(before) as (keyof MixerSnapshotFields)[];
  const changed: (keyof MixerSnapshotFields)[] = [];
  const unchanged: (keyof MixerSnapshotFields)[] = [];

  for (const key of keys) {
    if (before[key] !== after[key]) {
      changed.push(key);
    } else {
      unchanged.push(key);
    }
  }

  return { changed, unchanged };
}

function toSnapshotFields(raw: Awaited<ReturnType<MixerLens["getSnapshot"]>>): MixerSnapshotFields {
  return {
    totalDeposited: raw.totalDeposited,
    totalWithdrawn: raw.totalWithdrawn,
    depositCount: raw.depositCount,
    withdrawalCount: raw.withdrawalCount,
    poolBalance: raw.poolBalance,
    anonymitySetSize: raw.anonymitySetSize,
    treeCapacity: raw.treeCapacity,
    treeUtilization: raw.treeUtilization,
    lastRoot: raw.lastRoot,
    denomination: raw.denomination,
    isPaused: raw.isPaused,
    maxDepositsPerAddress: raw.maxDepositsPerAddress,
    owner: raw.owner,
    version: raw.version,
  };
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
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

  return { mixer, mixerLens, owner, depositor, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Lens Snapshot Diffs", function () {
  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------

  it("deposit changes exactly: depositCount, poolBalance, totalDeposited, anonymitySetSize, treeUtilization, lastRoot", async function () {
    const { mixer, mixerLens, depositor } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    const before = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const after = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));
    const diff = diffSnapshots(before, after);

    // Fields that must change
    expect(after.depositCount).to.equal(before.depositCount + 1n, "depositCount");
    expect(after.poolBalance).to.equal(before.poolBalance + DENOMINATION, "poolBalance");
    expect(after.totalDeposited).to.equal(before.totalDeposited + DENOMINATION, "totalDeposited");
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize + 1n, "anonymitySetSize");
    expect(after.treeUtilization).to.be.gt(before.treeUtilization, "treeUtilization");
    expect(after.lastRoot).to.not.equal(before.lastRoot, "lastRoot");

    // Fields that must NOT change
    for (const key of diff.unchanged) {
      expect(diff.unchanged).to.include(key);
    }
    const mustNotChange: (keyof MixerSnapshotFields)[] = [
      "withdrawalCount",
      "totalWithdrawn",
      "isPaused",
      "owner",
      "denomination",
      "treeCapacity",
      "maxDepositsPerAddress",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on deposit`);
    }
  });

  // -------------------------------------------------------------------------
  // withdraw
  // -------------------------------------------------------------------------

  it("withdraw changes exactly: withdrawalCount, poolBalance, totalWithdrawn, anonymitySetSize", async function () {
    const { mixer, mixerLens, depositor, recipient, relayer } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    // Setup: deposit so we have something to withdraw
    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nullifierHash = randomNullifierHash();
    const recipientAddr = recipient.address as `0x${string}`;
    const relayerAddr = relayer.address as `0x${string}`;

    const before = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));

    await mixer.withdraw(
      DUMMY_PA,
      DUMMY_PB,
      DUMMY_PC,
      root,
      nullifierHash,
      recipientAddr,
      relayerAddr,
      0n
    );

    const after = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));

    // Fields that must change
    expect(after.withdrawalCount).to.equal(before.withdrawalCount + 1n, "withdrawalCount");
    expect(after.poolBalance).to.equal(before.poolBalance - DENOMINATION, "poolBalance");
    expect(after.totalWithdrawn).to.equal(before.totalWithdrawn + DENOMINATION, "totalWithdrawn");
    expect(after.anonymitySetSize).to.equal(before.anonymitySetSize - 1n, "anonymitySetSize");

    // Fields that must NOT change
    const mustNotChange: (keyof MixerSnapshotFields)[] = [
      "depositCount",
      "totalDeposited",
      "isPaused",
      "owner",
      "denomination",
      "treeCapacity",
      "treeUtilization",
      "lastRoot",
      "maxDepositsPerAddress",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on withdraw`);
    }
  });

  // -------------------------------------------------------------------------
  // pause
  // -------------------------------------------------------------------------

  it("pause changes exactly: isPaused", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    const before = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));
    expect(before.isPaused).to.equal(false, "should not be paused initially");

    await mixer.connect(owner).pause();

    const after = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));
    const diff = diffSnapshots(before, after);

    expect(after.isPaused).to.equal(true, "isPaused should be true after pause");
    expect(diff.changed).to.deep.equal(["isPaused"], "only isPaused should change on pause");

    // All other fields unchanged
    const mustNotChange: (keyof MixerSnapshotFields)[] = [
      "totalDeposited",
      "totalWithdrawn",
      "depositCount",
      "withdrawalCount",
      "poolBalance",
      "anonymitySetSize",
      "treeCapacity",
      "treeUtilization",
      "lastRoot",
      "denomination",
      "maxDepositsPerAddress",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on pause`);
    }
  });

  // -------------------------------------------------------------------------
  // setMaxDepositsPerAddress (via timelock)
  // -------------------------------------------------------------------------

  it("setMaxDepositsPerAddress changes exactly: maxDepositsPerAddress", async function () {
    const { mixer, mixerLens, owner } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    const newMax = 5n;
    const actionHash = maxDepositsActionHash(newMax);
    await mixer.connect(owner).queueAction(actionHash);
    await time.increase(ONE_DAY + 1);

    const before = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));
    expect(before.maxDepositsPerAddress).to.equal(0n, "should be 0 initially");

    await mixer.connect(owner).setMaxDepositsPerAddress(newMax);

    const after = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));
    const diff = diffSnapshots(before, after);

    expect(after.maxDepositsPerAddress).to.equal(newMax, "maxDepositsPerAddress");
    expect(diff.changed).to.deep.equal(
      ["maxDepositsPerAddress"],
      "only maxDepositsPerAddress should change"
    );

    const mustNotChange: (keyof MixerSnapshotFields)[] = [
      "totalDeposited",
      "totalWithdrawn",
      "depositCount",
      "withdrawalCount",
      "poolBalance",
      "anonymitySetSize",
      "treeCapacity",
      "treeUtilization",
      "lastRoot",
      "denomination",
      "isPaused",
      "owner",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change on setMaxDepositsPerAddress`);
    }
  });

  // -------------------------------------------------------------------------
  // multiple deposits
  // -------------------------------------------------------------------------

  it("multiple deposits only change expected fields", async function () {
    const { mixer, mixerLens, depositor } = await loadFixture(deployFixture);
    const mixerAddress = await mixer.getAddress();

    const before = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));

    const depositCount = 3;
    for (let i = 0; i < depositCount; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const after = toSnapshotFields(await mixerLens.getSnapshot(mixerAddress));

    // Fields that must change
    expect(after.depositCount).to.equal(before.depositCount + BigInt(depositCount), "depositCount");
    expect(after.poolBalance).to.equal(before.poolBalance + DENOMINATION * BigInt(depositCount), "poolBalance");
    expect(after.totalDeposited).to.equal(
      before.totalDeposited + DENOMINATION * BigInt(depositCount),
      "totalDeposited"
    );
    expect(after.anonymitySetSize).to.equal(
      before.anonymitySetSize + BigInt(depositCount),
      "anonymitySetSize"
    );
    // treeUtilization = (depositCount * 100) / treeCapacity
    const expectedUtilization = (BigInt(depositCount) * 100n) / TREE_CAPACITY;
    expect(after.treeUtilization).to.equal(expectedUtilization, "treeUtilization");
    expect(after.lastRoot).to.not.equal(before.lastRoot, "lastRoot should update");

    // Fields that must NOT change
    const mustNotChange: (keyof MixerSnapshotFields)[] = [
      "withdrawalCount",
      "totalWithdrawn",
      "isPaused",
      "owner",
      "denomination",
      "treeCapacity",
      "maxDepositsPerAddress",
      "version",
    ];
    for (const key of mustNotChange) {
      expect(after[key]).to.deep.equal(before[key], `${key} should not change after multiple deposits`);
    }
  });
});
