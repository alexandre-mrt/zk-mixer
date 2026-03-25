import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
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
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddress);
}

async function doWithdraw(
  mixer: Mixer,
  nullifierHash: bigint,
  recipient: Signer,
  relayer: Signer,
  fee = 0n
) {
  const root = await mixer.getLastRoot();
  return mixer.withdraw(
    ZERO_PROOF.pA,
    ZERO_PROOF.pB,
    ZERO_PROOF.pC,
    root,
    nullifierHash,
    recipient.address as `0x${string}`,
    relayer.address as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployBaseFixture() {
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
  const base = await deployBaseFixture();
  const { mixer, owner } = base;

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  await timelockSetDepositReceipt(mixer, owner, await receipt.getAddress());

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Cross-Feature Verification
// ---------------------------------------------------------------------------

describe("Cross-Feature Verification", function () {
  // -------------------------------------------------------------------------
  // Receipt <-> Contract state
  // -------------------------------------------------------------------------

  it("receipt tokenCommitment matches commitmentIndex for all deposits", async function () {
    const { mixer, depositor, receipt } = await loadFixture(deployWithReceiptFixture);

    const commitments: bigint[] = [];
    for (let i = 0; i < 3; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
    }

    for (let i = 0; i < commitments.length; i++) {
      const tokenId = BigInt(i);
      const receiptCommitment = await receipt.tokenCommitment(tokenId);
      expect(receiptCommitment).to.equal(commitments[i]);

      // Cross-check: receipt commitment resolves to this leaf index
      const leafIndex = await mixer.getCommitmentIndex(receiptCommitment);
      expect(leafIndex).to.equal(BigInt(i));
      expect(await mixer.indexToCommitment(leafIndex)).to.equal(receiptCommitment);
    }
  });

  it("receipt count matches getStats.depositCount when receipt is configured", async function () {
    const { mixer, depositor, receipt } = await loadFixture(deployWithReceiptFixture);

    const count = 4;
    for (let i = 0; i < count; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }

    const [, , depositCount] = await mixer.getStats();
    const receiptBalance = await receipt.balanceOf(depositor.address);

    expect(depositCount).to.equal(BigInt(count));
    expect(receiptBalance).to.equal(depositCount);
  });

  it("receipt ownerOf matches the address that called deposit", async function () {
    const { mixer, depositor, receipt } = await loadFixture(deployWithReceiptFixture);
    const [, recipient] = await ethers.getSigners();

    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(recipient).deposit(randomCommitment(), { value: DENOMINATION });

    expect(await receipt.ownerOf(0n)).to.equal(depositor.address);
    expect(await receipt.ownerOf(1n)).to.equal(recipient.address);
  });

  // -------------------------------------------------------------------------
  // Events <-> State
  // -------------------------------------------------------------------------

  it("Deposit event commitment matches isCommitted(commitment)", async function () {
    const { mixer, depositor } = await loadFixture(deployBaseFixture);

    const commitment = randomCommitment();
    const tx = await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    const rxReceipt = await tx.wait();

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const mixerAddress = await mixer.getAddress();
    const depositLog = rxReceipt!.logs.find(
      (log) =>
        log.address.toLowerCase() === mixerAddress.toLowerCase() &&
        log.topics[0] === depositTopic
    );
    expect(depositLog).to.not.be.undefined;

    const parsed = mixer.interface.parseLog(depositLog!);
    const eventCommitment: bigint = parsed!.args[0];

    expect(eventCommitment).to.equal(commitment);
    expect(await mixer.isCommitted(eventCommitment)).to.be.true;
  });

  it("Withdrawal event nullifierHash matches isSpent(nullifier)", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployBaseFixture);

    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });

    const nullifierHash = randomCommitment();
    const tx = await doWithdraw(mixer, nullifierHash, recipient, relayer);
    const rxReceipt = await tx.wait();

    const withdrawalTopic = mixer.interface.getEvent("Withdrawal").topicHash;
    const mixerAddress = await mixer.getAddress();
    const withdrawalLog = rxReceipt!.logs.find(
      (log) =>
        log.address.toLowerCase() === mixerAddress.toLowerCase() &&
        log.topics[0] === withdrawalTopic
    );
    expect(withdrawalLog).to.not.be.undefined;

    const parsed = mixer.interface.parseLog(withdrawalLog!);
    const eventNullifier: bigint = parsed!.args[1]; // nullifierHash is args[1]

    expect(eventNullifier).to.equal(nullifierHash);
    expect(await mixer.isSpent(eventNullifier)).to.be.true;
  });

  it("Deposit event leafIndex matches getCommitmentIndex", async function () {
    const { mixer, depositor } = await loadFixture(deployBaseFixture);

    const depositTopic = mixer.interface.getEvent("Deposit").topicHash;
    const mixerAddress = await mixer.getAddress();

    const commitments: bigint[] = [];
    const eventLeafIndices: bigint[] = [];

    for (let i = 0; i < 3; i++) {
      const c = randomCommitment();
      commitments.push(c);

      const tx = await mixer.connect(depositor).deposit(c, { value: DENOMINATION });
      const rxReceipt = await tx.wait();

      const depositLog = rxReceipt!.logs.find(
        (log) =>
          log.address.toLowerCase() === mixerAddress.toLowerCase() &&
          log.topics[0] === depositTopic
      );
      const parsed = mixer.interface.parseLog(depositLog!);
      eventLeafIndices.push(BigInt(parsed!.args[1])); // leafIndex is args[1]
    }

    for (let i = 0; i < commitments.length; i++) {
      const storedIndex = await mixer.getCommitmentIndex(commitments[i]);
      expect(BigInt(storedIndex)).to.equal(eventLeafIndices[i]);
      expect(eventLeafIndices[i]).to.equal(BigInt(i));
    }
  });

  // -------------------------------------------------------------------------
  // Stats <-> Balance
  // -------------------------------------------------------------------------

  it("getStats.poolBalance always matches provider.getBalance", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployBaseFixture);
    const mixerAddress = await mixer.getAddress();

    // Before any action
    const [, , , , poolBalance0] = await mixer.getStats();
    expect(poolBalance0).to.equal(await ethers.provider.getBalance(mixerAddress));

    // After deposit
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    const [, , , , poolBalance1] = await mixer.getStats();
    expect(poolBalance1).to.equal(await ethers.provider.getBalance(mixerAddress));

    // After withdrawal
    await doWithdraw(mixer, randomCommitment(), recipient, relayer);
    const [, , , , poolBalance2] = await mixer.getStats();
    expect(poolBalance2).to.equal(await ethers.provider.getBalance(mixerAddress));
  });

  it("getStats values sum correctly: totalDeposited - totalWithdrawn == balance", async function () {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployBaseFixture);

    // Deposit 3 times
    for (let i = 0; i < 3; i++) {
      await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    }
    // Withdraw once
    await doWithdraw(mixer, randomCommitment(), recipient, relayer);

    const [totalDeposited, totalWithdrawn, , , poolBalance] = await mixer.getStats();
    expect(totalDeposited - totalWithdrawn).to.equal(poolBalance);
    expect(poolBalance).to.equal(DENOMINATION * 2n);
  });

  // -------------------------------------------------------------------------
  // MixerLens <-> Everything
  // -------------------------------------------------------------------------

  it("MixerLens every field matches individual getter", async function () {
    const { mixer, mixerLens, depositor, recipient, relayer } = await loadFixture(deployBaseFixture);

    // Deposit 2, withdraw 1 to create interesting state
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    await mixer.connect(depositor).deposit(randomCommitment(), { value: DENOMINATION });
    await doWithdraw(mixer, randomCommitment(), recipient, relayer);

    const mixerAddress = await mixer.getAddress();
    const snapshot = await mixerLens.getSnapshot(mixerAddress);

    const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
      await mixer.getStats();

    expect(snapshot.totalDeposited).to.equal(totalDeposited);
    expect(snapshot.totalWithdrawn).to.equal(totalWithdrawn);
    expect(snapshot.depositCount).to.equal(depositCount);
    expect(snapshot.withdrawalCount).to.equal(withdrawalCount);
    expect(snapshot.poolBalance).to.equal(poolBalance);
    expect(snapshot.poolBalance).to.equal(
      await ethers.provider.getBalance(mixerAddress)
    );
    expect(snapshot.anonymitySetSize).to.equal(await mixer.getAnonymitySetSize());
    expect(snapshot.treeCapacity).to.equal(await mixer.getTreeCapacity());
    expect(snapshot.treeUtilization).to.equal(await mixer.getTreeUtilization());
    expect(snapshot.lastRoot).to.equal(await mixer.getLastRoot());
    expect(snapshot.denomination).to.equal(await mixer.denomination());
    expect(snapshot.isPaused).to.equal(await mixer.paused());
    expect(snapshot.maxDepositsPerAddress).to.equal(await mixer.maxDepositsPerAddress());
    expect(snapshot.owner).to.equal(await mixer.owner());
  });

  it("MixerLens is consistent before and after state change", async function () {
    const { mixer, mixerLens, depositor, recipient, relayer } = await loadFixture(deployBaseFixture);
    const mixerAddress = await mixer.getAddress();

    // Snapshot before
    const snapshotBefore = await mixerLens.getSnapshot(mixerAddress);
    expect(snapshotBefore.depositCount).to.equal(0n);
    expect(snapshotBefore.poolBalance).to.equal(0n);

    // Deposit 3
    const commitment1 = randomCommitment();
    const commitment2 = randomCommitment();
    const commitment3 = randomCommitment();
    await mixer.connect(depositor).deposit(commitment1, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(commitment2, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(commitment3, { value: DENOMINATION });

    // Snapshot mid
    const snapshotMid = await mixerLens.getSnapshot(mixerAddress);
    expect(snapshotMid.depositCount).to.equal(3n);
    expect(snapshotMid.poolBalance).to.equal(DENOMINATION * 3n);
    expect(snapshotMid.anonymitySetSize).to.equal(3n);
    expect(snapshotMid.totalWithdrawn).to.equal(0n);

    // Withdraw once
    await doWithdraw(mixer, randomCommitment(), recipient, relayer);

    // Snapshot after
    const snapshotAfter = await mixerLens.getSnapshot(mixerAddress);
    expect(snapshotAfter.depositCount).to.equal(3n);
    expect(snapshotAfter.withdrawalCount).to.equal(1n);
    expect(snapshotAfter.poolBalance).to.equal(DENOMINATION * 2n);
    expect(snapshotAfter.anonymitySetSize).to.equal(2n);
    expect(snapshotAfter.totalDeposited).to.equal(DENOMINATION * 3n);
    expect(snapshotAfter.totalWithdrawn).to.equal(DENOMINATION);

    // Balance invariant holds at every snapshot
    expect(snapshotAfter.totalDeposited - snapshotAfter.totalWithdrawn).to.equal(
      snapshotAfter.poolBalance
    );
    expect(snapshotAfter.poolBalance).to.equal(
      await ethers.provider.getBalance(mixerAddress)
    );
  });
});
