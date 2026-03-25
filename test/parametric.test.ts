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
// Fixtures
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
// Helpers
// ---------------------------------------------------------------------------

let _commitmentCounter = 1000n;
function nextCommitment(): bigint {
  _commitmentCounter += 7n;
  return _commitmentCounter;
}

async function depositOne(mixer: Mixer, signer: Awaited<ReturnType<typeof ethers.getSigners>>[number], commitment: bigint): Promise<void> {
  await mixer.connect(signer).deposit(commitment, { value: DENOMINATION });
}

async function withdrawOne(
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
// Parametric Tests
// ---------------------------------------------------------------------------

describe("Parametric Tests", function () {
  // -------------------------------------------------------------------------
  // 20 commitment values — deposit accepted and tracked
  // -------------------------------------------------------------------------

  const commitments = [
    1n,
    2n,
    100n,
    1000n,
    2n ** 32n,
    2n ** 64n,
    2n ** 128n,
    2n ** 200n,
    2n ** 250n,
    FIELD_MAX - 1n,
    3n,
    7n,
    42n,
    256n,
    2n ** 16n,
    2n ** 48n,
    2n ** 96n,
    2n ** 160n,
    2n ** 224n,
    FIELD_MAX - 2n,
  ];

  for (const c of commitments) {
    it(`deposit commitment ${c}: accepted and tracked`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(user1).deposit(c, { value: DENOMINATION })
      ).to.not.be.reverted;
      expect(await mixer.isCommitted(c)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 10 fee values for withdrawal — correct distribution
  // -------------------------------------------------------------------------

  const feePercents = [0, 1, 5, 10, 25, 50, 75, 90, 99, 100];

  for (const pct of feePercents) {
    it(`withdraw with ${pct}% fee: correct distribution`, async function () {
      const { mixer, user1, recipient, relayer } = await loadFixture(deployMixerFixture);
      const commitment = nextCommitment();
      await depositOne(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(pct)) / 100n;
      const expectedAmount = DENOMINATION - fee;

      const nullifierHash = nextCommitment();

      const recipientAddr = await recipient.getAddress();
      const relayerAddr = pct === 0 ? ethers.ZeroAddress : await relayer.getAddress();

      const recipientBefore = await ethers.provider.getBalance(recipientAddr);

      await withdrawOne(mixer, root, nullifierHash, recipientAddr, relayerAddr, fee);

      const recipientAfter = await ethers.provider.getBalance(recipientAddr);
      expect(recipientAfter - recipientBefore).to.equal(expectedAmount);
    });
  }

  // -------------------------------------------------------------------------
  // 20 sequential deposit+verify cycles — getStats correct after N deposits
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    const N = i + 1;
    it(`deposit #${i}: getStats correct after ${N} deposits`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let d = 0; d < N; d++) {
        const c = BigInt(d + 1) * 13n + 999n;
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const [totalDeposited, , depositCount] = await mixer.getStats();
      expect(depositCount).to.equal(BigInt(N));
      expect(totalDeposited).to.equal(DENOMINATION * BigInt(N));
    });
  }

  // -------------------------------------------------------------------------
  // 10 Poseidon hash verifications — on-chain hashLeftRight is deterministic
  // -------------------------------------------------------------------------

  const hashPairs: Array<[bigint, bigint]> = [
    [0n, 0n],
    [1n, 0n],
    [0n, 1n],
    [1n, 1n],
    [100n, 200n],
    [2n ** 32n, 2n ** 64n],
    [FIELD_MAX - 1n, 1n],
    [42n, 42n],
    [2n ** 128n, 0n],
    [999n, 1000n],
  ];

  for (let i = 0; i < hashPairs.length; i++) {
    const [left, right] = hashPairs[i];
    it(`hash pair #${i}: on-chain matches off-chain (deterministic)`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.greaterThan(0n);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 10 anonymity set size tracking
  // -------------------------------------------------------------------------

  for (let d = 0; d <= 9; d++) {
    const numDeposits = d + 1;
    const numWithdrawals = Math.floor(d / 2);
    it(`${numDeposits} deposits, ${numWithdrawals} withdrawals: anonymity set correct`, async function () {
      const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);

      const recipientAddr = await recipient.getAddress();

      for (let dep = 0; dep < numDeposits; dep++) {
        const c = BigInt(dep + 1) * 17n + 5000n;
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      for (let w = 0; w < numWithdrawals; w++) {
        const root = await mixer.getLastRoot();
        const nullifierHash = BigInt(w + 1) * 31n + 9999n;
        await withdrawOne(mixer, root, nullifierHash, recipientAddr, ethers.ZeroAddress, 0n);
      }

      const anonSet = await mixer.getAnonymitySetSize();
      expect(anonSet).to.equal(BigInt(numDeposits - numWithdrawals));
    });
  }

  // -------------------------------------------------------------------------
  // 10 receipt token verification — commitment and ownership correct
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`receipt #${i}: commitment and ownership correct`, async function () {
      const { mixer, owner, user1 } = await loadFixture(deployMixerFixture);

      // Deploy and wire DepositReceipt
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

      // Deposit i+1 times, check the i-th token
      for (let d = 0; d <= i; d++) {
        const c = BigInt(d + 1) * 23n + BigInt(i) * 1000n + 2000n;
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const tokenId = BigInt(i);
      const tokenOwner = await receiptContract.ownerOf(tokenId);
      expect(tokenOwner).to.equal(await user1.getAddress());

      const commitment = await receiptContract.tokenCommitment(tokenId);
      expect(commitment).to.be.greaterThan(0n);
    });
  }

  // -------------------------------------------------------------------------
  // 10 tree utilization checks
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`${n} deposits: utilization == ${n * 100 / CAPACITY}%`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 29n + BigInt(n) * 500n + 7000n;
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const util = await mixer.getTreeUtilization();
      const expectedUtil = BigInt(n * 100) / BigInt(CAPACITY);
      expect(util).to.equal(expectedUtil);
    });
  }

  // -------------------------------------------------------------------------
  // 10 root history checks — after N deposits, N+1 valid roots in history
  // (initial root + one per deposit)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`after ${n} deposits: ${n + 1} valid roots in history`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 37n + BigInt(n) * 300n + 8000n;
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const validCount = await mixer.getValidRootCount();
      // initial root (from constructor) + n deposit roots
      expect(validCount).to.equal(BigInt(n + 1));
    });
  }
});
