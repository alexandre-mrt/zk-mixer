import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier, MixerLens } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DENOMINATION = ethers.parseEther("0.1");

// Height-5 tree: capacity = 32 (supports 15+ deposits required by scale tests)
const TREE_HEIGHT = 5;
const TREE_CAPACITY = 2 ** TREE_HEIGHT; // 32

const ROOT_HISTORY_SIZE = 30;

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

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(mixer: Mixer, signer: Signer, commitment?: bigint) {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return { commitment: c };
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipient: string,
  relayer: string,
  fee: bigint,
  caller?: Signer
) {
  const connected = caller ? mixer.connect(caller) : mixer;
  return connected.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipient as `0x${string}`,
    relayer as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployScaleFixture() {
  const signers = await ethers.getSigners();
  const [owner] = signers;

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  const MixerLensFactory = await ethers.getContractFactory("MixerLens");
  const mixerLens = (await MixerLensFactory.deploy()) as unknown as MixerLens;

  return { mixer, mixerLens, owner, signers };
}

// ---------------------------------------------------------------------------
// Scale Tests
// ---------------------------------------------------------------------------

describe("Scale Tests", function () {
  // Height-5 tree, 15 deposits, 20 available Hardhat signers
  const DEPOSIT_COUNT = 15;
  const WITHDRAW_COUNT = 10;

  it("15 deposits: all stats correct", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(mixer, signers[(i % 19) + 1]);
    }

    const [totalDeposited, , depositCount, , poolBalance] = await mixer.getStats();

    expect(depositCount).to.equal(BigInt(DEPOSIT_COUNT));
    expect(totalDeposited).to.equal(DENOMINATION * BigInt(DEPOSIT_COUNT));
    expect(poolBalance).to.equal(DENOMINATION * BigInt(DEPOSIT_COUNT));
    expect(await mixer.nextIndex()).to.equal(BigInt(DEPOSIT_COUNT));
  });

  it("15 deposits + 10 withdrawals: balance == 5 * denomination", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(mixer, signers[(i % 19) + 1]);
    }

    const root = await mixer.getLastRoot();

    for (let i = 0; i < WITHDRAW_COUNT; i++) {
      const nullifierHash = randomCommitment();
      await doWithdraw(
        mixer,
        root,
        nullifierHash,
        signers[1].address,
        ethers.ZeroAddress,
        0n,
        signers[0]
      );
    }

    const [, , , withdrawalCount, poolBalance] = await mixer.getStats();

    expect(withdrawalCount).to.equal(BigInt(WITHDRAW_COUNT));
    expect(poolBalance).to.equal(
      DENOMINATION * BigInt(DEPOSIT_COUNT - WITHDRAW_COUNT)
    );
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * BigInt(DEPOSIT_COUNT - WITHDRAW_COUNT));
  });

  it("15 deposits: all commitments retrievable via getCommitments", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    const commitments: bigint[] = [];
    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      const c = randomCommitment();
      commitments.push(c);
      await doDeposit(mixer, signers[(i % 19) + 1], c);
    }

    // Retrieve all in one call
    const fetched = await mixer.getCommitments(0, DEPOSIT_COUNT);
    expect(fetched.length).to.equal(DEPOSIT_COUNT);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      expect(fetched[i]).to.equal(commitments[i]);
    }
  });

  it("15 deposits: tree utilization > 0", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(mixer, signers[(i % 19) + 1]);
    }

    const utilization = await mixer.getTreeUtilization();
    const expectedUtilization = (BigInt(DEPOSIT_COUNT) * 100n) / BigInt(TREE_CAPACITY);

    expect(utilization).to.be.gt(0n);
    expect(utilization).to.equal(expectedUtilization);
  });

  it("15 deposits: anonymitySetSize == 15", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(mixer, signers[(i % 19) + 1]);
    }

    expect(await mixer.getAnonymitySetSize()).to.equal(BigInt(DEPOSIT_COUNT));
  });

  it("15 deposits by 5 different users: each has 3 deposits", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    // 5 users, 3 deposits each = 15 total
    const users = [signers[1], signers[2], signers[3], signers[4], signers[5]];
    for (let round = 0; round < 3; round++) {
      for (const user of users) {
        await doDeposit(mixer, user);
      }
    }

    for (const user of users) {
      expect(await mixer.depositsPerAddress(user.address)).to.equal(3n);
    }

    expect(await mixer.nextIndex()).to.equal(15n);
  });

  it("5 users deposit, 5 different users withdraw", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    const depositors = [signers[1], signers[2], signers[3], signers[4], signers[5]];
    const withdrawers = [signers[6], signers[7], signers[8], signers[9], signers[10]];

    for (const user of depositors) {
      await doDeposit(mixer, user);
    }

    const root = await mixer.getLastRoot();

    for (let i = 0; i < withdrawers.length; i++) {
      const nullifierHash = randomCommitment();
      const balanceBefore = await ethers.provider.getBalance(withdrawers[i].address);

      await doWithdraw(
        mixer,
        root,
        nullifierHash,
        withdrawers[i].address,
        ethers.ZeroAddress,
        0n,
        signers[0]
      );

      const balanceAfter = await ethers.provider.getBalance(withdrawers[i].address);
      expect(balanceAfter - balanceBefore).to.equal(DENOMINATION);
    }

    // Depositors' counts are unchanged
    for (const user of depositors) {
      expect(await mixer.depositsPerAddress(user.address)).to.equal(1n);
    }
  });

  it("root history fills after 30+ deposits", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    // ROOT_HISTORY_SIZE + 1 = 31 deposits: forces first root out of ring buffer
    const totalDeposits = ROOT_HISTORY_SIZE + 1;
    const rootsInOrder: bigint[] = [];

    for (let i = 0; i < totalDeposits; i++) {
      await doDeposit(mixer, signers[(i % 19) + 1]);
      rootsInOrder.push(await mixer.getLastRoot());
    }

    // First root must have been evicted
    expect(await mixer.isKnownRoot(rootsInOrder[0])).to.be.false;

    // Last root must still be known
    expect(await mixer.isKnownRoot(rootsInOrder[totalDeposits - 1])).to.be.true;

    // Root at position ROOT_HISTORY_SIZE - 1 is at the edge of the window — still known
    expect(await mixer.isKnownRoot(rootsInOrder[ROOT_HISTORY_SIZE - 1])).to.be.true;
  });

  it("receipts track all 10 deposits correctly", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);
    const [owner] = signers;

    const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
    const receipt = await DepositReceiptFactory.deploy(await mixer.getAddress());

    // Wire receipt via timelock
    const { time } = await import("@nomicfoundation/hardhat-toolbox/network-helpers");
    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "address"],
        ["setDepositReceipt", await receipt.getAddress()]
      )
    );
    await mixer.connect(owner).queueAction(actionHash);
    await time.increase(24 * 60 * 60 + 1);
    await mixer.connect(owner).setDepositReceipt(await receipt.getAddress());

    const depositUsers = signers.slice(1, 11); // 10 distinct users
    for (const user of depositUsers) {
      await doDeposit(mixer, user);
    }

    // Each user holds exactly 1 receipt
    for (const user of depositUsers) {
      expect(await receipt.balanceOf(user.address)).to.equal(1n);
    }

    // Token IDs 0..9 assigned in insertion order, one per user
    for (let i = 0; i < depositUsers.length; i++) {
      expect(await receipt.ownerOf(i)).to.equal(depositUsers[i].address);
    }
  });

  it("getValidRootCount saturates at ROOT_HISTORY_SIZE", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    // After ROOT_HISTORY_SIZE deposits the ring buffer is full
    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      await doDeposit(mixer, signers[(i % 19) + 1]);
    }

    const validCount = await mixer.getValidRootCount();
    expect(validCount).to.equal(ROOT_HISTORY_SIZE);

    // More deposits do not increase the count beyond ROOT_HISTORY_SIZE
    await doDeposit(mixer, signers[1]);
    expect(await mixer.getValidRootCount()).to.equal(ROOT_HISTORY_SIZE);
  });

  it("all 15 deposit events emitted correctly", async function () {
    const { mixer, signers } = await loadFixture(deployScaleFixture);

    const commitments: bigint[] = [];
    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      const c = randomCommitment();
      commitments.push(c);
      const tx = await mixer.connect(signers[(i % 19) + 1]).deposit(c, { value: DENOMINATION });
      await expect(tx)
        .to.emit(mixer, "Deposit")
        .withArgs(c, i, (v: bigint) => v > 0n);
    }

    // Verify leafIndex sequencing: commitmentIndex[c] matches insertion order
    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      expect(await mixer.commitmentIndex(commitments[i])).to.equal(i);
    }
  });

  it("MixerLens snapshot at scale reflects correct values", async function () {
    const { mixer, mixerLens, signers } = await loadFixture(deployScaleFixture);

    for (let i = 0; i < DEPOSIT_COUNT; i++) {
      await doDeposit(mixer, signers[(i % 19) + 1]);
    }

    // Single withdrawal
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();
    await doWithdraw(mixer, root, nullifierHash, signers[1].address, ethers.ZeroAddress, 0n, signers[0]);

    const snapshot = await mixerLens.getSnapshot(await mixer.getAddress());

    expect(snapshot.depositCount).to.equal(BigInt(DEPOSIT_COUNT));
    expect(snapshot.withdrawalCount).to.equal(1n);
    expect(snapshot.totalDeposited).to.equal(DENOMINATION * BigInt(DEPOSIT_COUNT));
    expect(snapshot.totalWithdrawn).to.equal(DENOMINATION);
    expect(snapshot.poolBalance).to.equal(
      DENOMINATION * BigInt(DEPOSIT_COUNT - 1)
    );
    expect(snapshot.anonymitySetSize).to.equal(BigInt(DEPOSIT_COUNT - 1));
    expect(snapshot.treeUtilization).to.be.gt(0n);
    expect(snapshot.treeCapacity).to.equal(BigInt(TREE_CAPACITY));
    expect(snapshot.denomination).to.equal(DENOMINATION);
    expect(snapshot.isPaused).to.equal(false);
    expect(snapshot.lastRoot).to.not.equal(0n);
  });
});
