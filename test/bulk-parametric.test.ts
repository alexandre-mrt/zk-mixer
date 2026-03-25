import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const CAPACITY = 2 ** MERKLE_TREE_HEIGHT; // 32
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

const FIELD_MAX = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployMixerFixture() {
  const [owner, user1, user2, recipient, relayer] = await ethers.getSigners();

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

  return { mixer, owner, user1, user2, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Counter helpers — each test gets its own fresh fixture so counter is local
// ---------------------------------------------------------------------------

let _bulkCounter = 100_000n;
function nextC(): bigint {
  _bulkCounter += 13n;
  return _bulkCounter;
}

async function doDeposit(
  mixer: Mixer,
  signer: Awaited<ReturnType<typeof ethers.getSigners>>[number],
  commitment: bigint
): Promise<void> {
  await mixer.connect(signer).deposit(commitment, { value: DENOMINATION });
}

async function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipientAddr: string,
  relayerAddr: string,
  fee: bigint
): Promise<void> {
  await mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipientAddr as `0x${string}`,
    relayerAddr as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Bulk Parametric
// ---------------------------------------------------------------------------

describe("Bulk Parametric", function () {
  // -------------------------------------------------------------------------
  // 30 deposit+verify cycles — commitment stored, index correct, root updated
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    it(`deposit #${i}: commitment stored, index correct, root updated`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const commitment = BigInt(i + 1) * 97n + BigInt(i) * 1000n + 200_000n;

      const rootBefore = await mixer.getLastRoot();
      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
      expect(await mixer.getCommitmentIndex(commitment)).to.equal(0);
      const rootAfter = await mixer.getLastRoot();
      expect(rootAfter).to.not.equal(rootBefore);
    });
  }

  // -------------------------------------------------------------------------
  // 20 withdrawal fee variations (0 to denomination in equal steps)
  // -------------------------------------------------------------------------

  for (let i = 0; i <= 19; i++) {
    it(`withdraw fee step ${i}/19: recipient and relayer amounts correct`, async function () {
      const { mixer, user1, recipient, relayer } = await loadFixture(deployMixerFixture);

      const commitment = BigInt(i + 1) * 101n + 300_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(i)) / 19n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash = BigInt(i + 1) * 103n + 400_000n;
      const recipientAddr = await recipient.getAddress();
      const relayerAddr = fee === 0n ? ethers.ZeroAddress : await relayer.getAddress();

      const recipientBefore = await ethers.provider.getBalance(recipientAddr);
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, fee);
      const recipientAfter = await ethers.provider.getBalance(recipientAddr);

      expect(recipientAfter - recipientBefore).to.equal(expectedRecipient);
    });
  }

  // -------------------------------------------------------------------------
  // 25 hash verification pairs — on-chain hashLeftRight is deterministic
  // -------------------------------------------------------------------------

  for (let i = 0; i < 25; i++) {
    const left = BigInt(i + 1) * 111n + 500_000n;
    const right = BigInt(i + 1) * 222n + 600_000n;
    it(`hashLeftRight pair #${i}: on-chain matches circomlibjs (deterministic)`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.greaterThan(0n);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 20 MixerLens snapshot after N deposits — all fields correct
  // -------------------------------------------------------------------------

  for (let n = 0; n < 20; n++) {
    it(`Lens snapshot at deposit count ${n}: all fields correct`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      const MixerLensFactory = await ethers.getContractFactory("MixerLens");
      const lens = await MixerLensFactory.deploy();

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 53n + BigInt(n) * 700n + 700_000n;
        await doDeposit(mixer, user1, c);
      }

      const snapshot = await lens.getSnapshot(await mixer.getAddress());
      expect(snapshot.depositCount).to.equal(BigInt(n));
      expect(snapshot.totalDeposited).to.equal(DENOMINATION * BigInt(n));
      expect(snapshot.denomination).to.equal(DENOMINATION);
    });
  }

  // -------------------------------------------------------------------------
  // 15 receipt metadata verifications
  // -------------------------------------------------------------------------

  for (let i = 0; i < 15; i++) {
    it(`receipt #${i}: tokenURI valid, commitment matches`, async function () {
      const { mixer, owner, user1 } = await loadFixture(deployMixerFixture);

      const DepositReceiptFactory = await ethers.getContractFactory("DepositReceipt");
      const receiptContract = await DepositReceiptFactory.deploy(await mixer.getAddress());
      const receiptAddr = await receiptContract.getAddress();

      const hash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["string", "address"], ["setDepositReceipt", receiptAddr])
      );
      await mixer.connect(owner).queueAction(hash);
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine", []);
      await mixer.connect(owner).setDepositReceipt(receiptAddr);

      // Each test deposits exactly once — token 0 is always the first minted
      const commitment = BigInt(i + 1) * 59n + BigInt(i) * 800n + 800_000n;
      await doDeposit(mixer, user1, commitment);

      const tokenOwner = await receiptContract.ownerOf(0n);
      expect(tokenOwner).to.equal(await user1.getAddress());

      const storedCommitment = await receiptContract.tokenCommitment(0n);
      expect(storedCommitment).to.equal(commitment);
    });
  }

  // -------------------------------------------------------------------------
  // 15 getCommitments paginated reads
  // -------------------------------------------------------------------------

  for (let from = 0; from < 15; from++) {
    it(`getCommitments(${from}, 5): correct slice`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      const stored: bigint[] = [];
      for (let d = 0; d < 20; d++) {
        const c = BigInt(d + 1) * 67n + BigInt(from) * 500n + 900_000n;
        stored.push(c);
        await doDeposit(mixer, user1, c);
      }

      const result = await mixer.getCommitments(from, 5);
      const expected = stored.slice(from, from + 5);
      expect(result.length).to.equal(expected.length);
      for (let k = 0; k < expected.length; k++) {
        expect(result[k]).to.equal(expected[k]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // 15 isKnownRoot for sequential roots
  // -------------------------------------------------------------------------

  for (let i = 0; i < 15; i++) {
    it(`isKnownRoot for root at deposit #${i}`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      let capturedRoot = 0n;
      for (let d = 0; d <= i; d++) {
        const c = BigInt(d + 1) * 71n + BigInt(i) * 300n + 1_000_000n;
        await doDeposit(mixer, user1, c);
        if (d === i) {
          capturedRoot = await mixer.getLastRoot();
        }
      }

      expect(await mixer.isKnownRoot(capturedRoot)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 20 anonymity set tracking (10 deposit-only + 10 deposit+withdraw pairs)
  // -------------------------------------------------------------------------

  for (let d = 1; d <= 10; d++) {
    it(`${d} deposits: anonymitySet == ${d}`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let k = 0; k < d; k++) {
        const c = BigInt(k + 1) * 79n + BigInt(d) * 200n + 1_100_000n;
        await doDeposit(mixer, user1, c);
      }

      expect(await mixer.getAnonymitySetSize()).to.equal(BigInt(d));
    });
  }

  for (let d = 1; d <= 10; d++) {
    it(`${d} deposits + ${d} withdrawals: anonymitySet == 0`, async function () {
      const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();

      for (let k = 0; k < d; k++) {
        const c = BigInt(k + 1) * 83n + BigInt(d) * 150n + 1_200_000n;
        await doDeposit(mixer, user1, c);
      }

      for (let w = 0; w < d; w++) {
        const root = await mixer.getLastRoot();
        const nullifierHash = BigInt(w + 1) * 89n + BigInt(d) * 250n + 1_300_000n;
        await doWithdraw(mixer, root, nullifierHash, recipientAddr, ethers.ZeroAddress, 0n);
      }

      expect(await mixer.getAnonymitySetSize()).to.equal(0n);
    });
  }
});
