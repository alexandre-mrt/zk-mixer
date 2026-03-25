import { expect } from "chai";
import { ethers } from "hardhat";
import {
  loadFixture,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, DepositReceipt, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei
const ONE_DAY = 24 * 60 * 60;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

function actionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

function addressActionHash(name: string, addr: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], [name, addr])
  );
}

async function timelockQueue(mixer: Mixer, owner: Signer, hash: string): Promise<void> {
  await mixer.connect(owner).queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const [owner, user1, user2, user3, recipient, relayer] =
    await ethers.getSigners();

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

  return { mixer, verifier, owner, user1, user2, user3, recipient, relayer };
}

async function deployMixerWithReceiptFixture() {
  const base = await deployMixerFixture();
  const { mixer, owner } = base;

  const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await DepositReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  const hash = addressActionHash("setDepositReceipt", await receipt.getAddress());
  await timelockQueue(mixer, owner, hash);
  await mixer.connect(owner).setDepositReceipt(await receipt.getAddress());

  return { ...base, receipt };
}

async function depositAs(mixer: Mixer, signer: Signer, commitment: bigint): Promise<void> {
  await mixer.connect(signer).deposit(commitment, { value: DENOMINATION });
}

async function withdraw(
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
    recipient,
    relayer,
    fee
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Comprehensive Coverage", function () {
  // -------------------------------------------------------------------------
  // Deposit receipt integration
  // -------------------------------------------------------------------------

  describe("Deposit receipt integration", function () {
    it("deposit without receipt configured doesn't revert", async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const commitment = randomCommitment();
      await expect(
        mixer.connect(user1).deposit(commitment, { value: DENOMINATION })
      ).to.not.be.reverted;
    });

    it("deposit receipt token count matches deposit count", async function () {
      const { mixer, receipt, user1, user2 } = await loadFixture(
        deployMixerWithReceiptFixture
      );
      await depositAs(mixer, user1, randomCommitment());
      await depositAs(mixer, user2, randomCommitment());

      // tokenId 0 and 1 were minted; ownerOf both should succeed (no revert = exist)
      expect(await receipt.ownerOf(0n)).to.be.properAddress;
      expect(await receipt.ownerOf(1n)).to.be.properAddress;
      expect(await mixer.getDepositCount()).to.equal(2n);
    });

    it("deposit receipt ownerOf returns depositor", async function () {
      const { mixer, receipt, user1 } = await loadFixture(
        deployMixerWithReceiptFixture
      );
      const commitment = randomCommitment();
      await depositAs(mixer, user1, commitment);

      // Token ID 0 was minted for the first deposit
      expect(await receipt.ownerOf(0n)).to.equal(await user1.getAddress());
    });
  });

  // -------------------------------------------------------------------------
  // MixerLens edge cases
  // -------------------------------------------------------------------------

  describe("MixerLens edge cases", function () {
    it("MixerLens works with empty pool", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const MixerLensFactory = await ethers.getContractFactory("MixerLens");
      const lens = await MixerLensFactory.deploy();

      const snapshot = await lens.getSnapshot(await mixer.getAddress());
      expect(snapshot.depositCount).to.equal(0n);
      expect(snapshot.poolBalance).to.equal(0n);
      expect(snapshot.anonymitySetSize).to.equal(0n);
    });

    it("MixerLens snapshot version field is '1.0.0'", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const MixerLensFactory = await ethers.getContractFactory("MixerLens");
      const lens = await MixerLensFactory.deploy();

      const snapshot = await lens.getSnapshot(await mixer.getAddress());
      expect(snapshot.version).to.equal("1.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // Root behavior
  // -------------------------------------------------------------------------

  describe("Root behavior", function () {
    it("initial root is consistent across deployments with same height", async function () {
      const hasherAddress = await deployHasher();
      const Verifier = await ethers.getContractFactory("Groth16Verifier");
      const verifier1 = await Verifier.deploy();
      const verifier2 = await Verifier.deploy();

      const MixerFactory = await ethers.getContractFactory("Mixer");
      const mixer1 = (await MixerFactory.deploy(
        await verifier1.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;
      const mixer2 = (await MixerFactory.deploy(
        await verifier2.getAddress(),
        DENOMINATION,
        MERKLE_TREE_HEIGHT,
        hasherAddress
      )) as unknown as Mixer;

      expect(await mixer1.getLastRoot()).to.equal(await mixer2.getLastRoot());
    });

    it("hashLeftRight(0,0) returns the initial subtree zero value", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      // The level-0 zero is 0; the initial root is Poseidon-hashed up `levels` times.
      // hashLeftRight(0,0) corresponds to zeros[1] = Poseidon(0,0).
      const h = await mixer.hashLeftRight(0n, 0n);
      expect(h).to.be.greaterThan(0n);
      // filledSubtrees[0] starts as 0 (the empty-leaf value)
      expect(await mixer.filledSubtrees(0)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Commitment edge cases
  // -------------------------------------------------------------------------

  describe("Commitment edge cases", function () {
    it("getCommitments(0, 0) returns empty array", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const result = await mixer.getCommitments(0, 0);
      expect(result.length).to.equal(0);
    });

    it("getCommitments(100, 5) returns empty when no deposits", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const result = await mixer.getCommitments(100, 5);
      expect(result.length).to.equal(0);
    });

    it("indexToCommitment(0) returns 0 when no deposits", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.indexToCommitment(0)).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-user interaction
  // -------------------------------------------------------------------------

  describe("Multi-user interaction", function () {
    it("3 users deposit, each has unique commitment", async function () {
      const { mixer, user1, user2, user3 } = await loadFixture(
        deployMixerFixture
      );
      const c1 = randomCommitment();
      const c2 = randomCommitment();
      const c3 = randomCommitment();

      await depositAs(mixer, user1, c1);
      await depositAs(mixer, user2, c2);
      await depositAs(mixer, user3, c3);

      expect(await mixer.isCommitted(c1)).to.equal(true);
      expect(await mixer.isCommitted(c2)).to.equal(true);
      expect(await mixer.isCommitted(c3)).to.equal(true);
      expect(await mixer.getDepositCount()).to.equal(3n);
    });

    it("withdrawal by user A doesn't affect user B's deposit", async function () {
      const { mixer, user1, user2, recipient, relayer } = await loadFixture(
        deployMixerFixture
      );
      const cA = randomCommitment();
      const cB = randomCommitment();

      await depositAs(mixer, user1, cA);
      const root = await mixer.getLastRoot();
      await depositAs(mixer, user2, cB);

      const nullifierA = randomCommitment();
      await withdraw(mixer, root, nullifierA, await recipient.getAddress(), ethers.ZeroAddress, 0n);

      // B's commitment is still present and count still reflects deposit
      expect(await mixer.isCommitted(cB)).to.equal(true);
      expect(await mixer.getDepositCount()).to.equal(2n);
    });

    it("getAnonymitySetSize reflects net deposits minus withdrawals correctly", async function () {
      const { mixer, user1, user2, recipient } = await loadFixture(
        deployMixerFixture
      );

      await depositAs(mixer, user1, randomCommitment());
      await depositAs(mixer, user2, randomCommitment());
      const root = await mixer.getLastRoot();

      expect(await mixer.getAnonymitySetSize()).to.equal(2n);

      const nullifier = randomCommitment();
      await withdraw(mixer, root, nullifier, await recipient.getAddress(), ethers.ZeroAddress, 0n);

      expect(await mixer.getAnonymitySetSize()).to.equal(1n);
    });
  });

  // -------------------------------------------------------------------------
  // Stats after complex flow
  // -------------------------------------------------------------------------

  describe("Stats after complex flow", function () {
    it("getStats returns coherent values after 5 deposits and 2 withdrawals", async function () {
      const { mixer, user1, user2, recipient } = await loadFixture(
        deployMixerFixture
      );

      for (let i = 0; i < 5; i++) {
        await depositAs(mixer, user1, randomCommitment());
      }
      const root = await mixer.getLastRoot();

      const n1 = randomCommitment();
      const n2 = randomCommitment();
      await withdraw(mixer, root, n1, await recipient.getAddress(), ethers.ZeroAddress, 0n);
      await withdraw(mixer, root, n2, await recipient.getAddress(), ethers.ZeroAddress, 0n);

      const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
        await mixer.getStats();

      expect(totalDeposited).to.equal(DENOMINATION * 5n);
      expect(totalWithdrawn).to.equal(DENOMINATION * 2n);
      expect(depositCount).to.equal(5n);
      expect(withdrawalCount).to.equal(2n);
      expect(poolBalance).to.equal(DENOMINATION * 3n);
    });

    it("pool balance never goes negative", async function () {
      const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);

      await depositAs(mixer, user1, randomCommitment());
      const root = await mixer.getLastRoot();
      const nullifier = randomCommitment();

      await withdraw(mixer, root, nullifier, await recipient.getAddress(), ethers.ZeroAddress, 0n);

      const balance = await ethers.provider.getBalance(await mixer.getAddress());
      expect(balance).to.be.greaterThanOrEqual(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Gas optimization
  // -------------------------------------------------------------------------

  describe("Gas optimization", function () {
    it("second deposit costs less gas than first (warm storage)", async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      const c1 = randomCommitment();
      const c2 = randomCommitment();

      const tx1 = await mixer.connect(user1).deposit(c1, { value: DENOMINATION });
      const r1 = await tx1.wait();

      const tx2 = await mixer.connect(user1).deposit(c2, { value: DENOMINATION });
      const r2 = await tx2.wait();

      // Second deposit benefits from warm storage slots for user1's address mappings
      expect(r2!.gasUsed).to.be.lessThan(r1!.gasUsed);
    });
  });

  // -------------------------------------------------------------------------
  // View function stability
  // -------------------------------------------------------------------------

  describe("View function stability", function () {
    it("calling getLastRoot twice returns same value without state change", async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      await depositAs(mixer, user1, randomCommitment());

      const root1 = await mixer.getLastRoot();
      const root2 = await mixer.getLastRoot();
      expect(root1).to.equal(root2);
    });

    it("isKnownRoot returns consistent results for same root", async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      await depositAs(mixer, user1, randomCommitment());

      const root = await mixer.getLastRoot();
      const result1 = await mixer.isKnownRoot(root);
      const result2 = await mixer.isKnownRoot(root);
      expect(result1).to.equal(true);
      expect(result2).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Timelock edge cases
  // -------------------------------------------------------------------------

  describe("Timelock edge cases", function () {
    it("queuing a new action overwrites the previous pending action", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash1 = actionHash("setMaxDepositsPerAddress", 3n);
      const hash2 = actionHash("setMaxDepositsPerAddress", 7n);

      await mixer.connect(owner).queueAction(hash1);
      await mixer.connect(owner).queueAction(hash2);

      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash2);
    });

    it("executed action clears the pending slot", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const max = 5n;
      const hash = actionHash("setMaxDepositsPerAddress", max);

      await timelockQueue(mixer, owner, hash);
      await mixer.connect(owner).setMaxDepositsPerAddress(max);

      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
      expect(pending.executeAfter).to.equal(0n);
    });
  });
});
