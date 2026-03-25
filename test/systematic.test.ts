import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier, MixerLens, DepositReceipt } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const MERKLE_TREE_HEIGHT = 5; // capacity = 32
const ONE_DAY = 86_400;

const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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

// Deterministic commitment from an index — keeps tests reproducible
function indexedCommitment(i: number): bigint {
  return BigInt(i + 1) * 1000000000000n;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(
  mixer: Mixer,
  signer: Signer,
  commitment?: bigint
): Promise<{ commitment: bigint }> {
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
  caller: Signer
): Promise<void> {
  await mixer.connect(caller).withdraw(
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

async function deployMixerWithLensFixture() {
  const base = await deployMixerFixture();
  const LensFactory = await ethers.getContractFactory("MixerLens");
  const lens = (await LensFactory.deploy()) as unknown as MixerLens;
  return { ...base, lens };
}

async function deployMixerWithReceiptFixture() {
  const base = await deployMixerFixture();
  const { mixer, owner } = base;

  const ReceiptFactory = await ethers.getContractFactory("DepositReceipt");
  const receipt = (await ReceiptFactory.deploy(
    await mixer.getAddress()
  )) as unknown as DepositReceipt;

  const receiptAddr = await receipt.getAddress();
  const ah = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address"],
      ["setDepositReceipt", receiptAddr]
    )
  );
  await mixer.connect(owner).queueAction(ah);
  await time.increase(ONE_DAY + 1);
  await mixer.connect(owner).setDepositReceipt(receiptAddr);

  return { ...base, receipt };
}

// ---------------------------------------------------------------------------
// Systematic Tests
// ---------------------------------------------------------------------------

describe("Systematic Tests", function () {
  // -------------------------------------------------------------------------
  // deposit with N different commitments (20 tests)
  // -------------------------------------------------------------------------

  for (let i = 1; i <= 20; i++) {
    it(`deposit #${i}: unique commitment deposited and tracked`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const commitment = indexedCommitment(i);

      await mixer.connect(user1).deposit(commitment, { value: DENOMINATION });

      expect(await mixer.commitments(commitment)).to.equal(true);
      expect(await mixer.isCommitted(commitment)).to.equal(true);
      expect(await mixer.getDepositCount()).to.equal(1);
    });
  }

  // -------------------------------------------------------------------------
  // withdraw with various fee amounts (10 tests)
  // -------------------------------------------------------------------------

  const fees = [
    0n,
    1n,
    100n,
    1000n,
    ethers.parseEther("0.001"),
    ethers.parseEther("0.01"),
    ethers.parseEther("0.05"),
    ethers.parseEther("0.09"),
    ethers.parseEther("0.099"),
    DENOMINATION, // full denomination as fee
  ];

  for (const fee of fees) {
    it(`withdraw with fee ${ethers.formatEther(fee)} ETH`, async function () {
      const { mixer, user1, recipient, relayer } = await loadFixture(deployMixerFixture);

      const commitment = randomCommitment();
      await mixer.connect(user1).deposit(commitment, { value: DENOMINATION });
      const root = await mixer.getLastRoot();

      const nullifierHash = BigInt(ethers.id(`nullifier-fee-${fee.toString()}`));

      await doWithdraw(
        mixer,
        root,
        nullifierHash,
        await recipient.getAddress(),
        fee > 0n ? await relayer.getAddress() : ethers.ZeroAddress,
        fee,
        user1
      );

      expect(await mixer.nullifierHashes(nullifierHash)).to.equal(true);
      expect(await mixer.isSpent(nullifierHash)).to.equal(true);
    });
  }

  // -------------------------------------------------------------------------
  // isKnownRoot for N sequential roots (15 tests)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 15; i++) {
    it(`isKnownRoot true for root after deposit #${i + 1}`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      // Make i+1 deposits, capturing each root
      let lastRoot: bigint = 0n;
      for (let j = 0; j <= i; j++) {
        const c = indexedCommitment(j + 100 + i * 20);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
        lastRoot = await mixer.getLastRoot();
      }

      expect(await mixer.isKnownRoot(lastRoot)).to.equal(true);
    });
  }

  // -------------------------------------------------------------------------
  // getCommitments pagination slices (10 tests)
  // -------------------------------------------------------------------------

  for (let from = 0; from < 10; from++) {
    it(`getCommitments(${from}, 3) returns correct slice`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      const commitmentList: bigint[] = [];
      for (let j = 0; j < 12; j++) {
        const c = indexedCommitment(j + 200 + from * 15);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
        commitmentList.push(c);
      }

      const slice = await mixer.getCommitments(from, 3);
      expect(slice.length).to.equal(3);
      for (let k = 0; k < 3; k++) {
        expect(slice[k]).to.equal(commitmentList[from + k]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // hashLeftRight with various inputs (15 tests)
  // -------------------------------------------------------------------------

  const hashPairs: [bigint, bigint][] = [
    [0n, 0n],
    [1n, 0n],
    [0n, 1n],
    [1n, 1n],
    [42n, 43n],
    [100n, 200n],
    [999n, 1n],
    [FIELD_SIZE - 1n, 0n],
    [0n, FIELD_SIZE - 1n],
    [FIELD_SIZE - 2n, FIELD_SIZE - 3n],
    [123456789n, 987654321n],
    [2n ** 128n - 1n, 1n],
    [2n ** 200n - 1n, 1n],
    [1n, 2n ** 200n - 1n],
    [12345n, 67890n],
  ];

  for (const [a, b] of hashPairs) {
    it(`hashLeftRight(${a.toString().slice(0, 10)}, ${b.toString().slice(0, 10)}) returns consistent result`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);

      const result1 = await mixer.hashLeftRight(a, b);
      const result2 = await mixer.hashLeftRight(a, b);

      // Deterministic: same inputs produce same output
      expect(result1).to.equal(result2);
      // Result is a valid field element
      expect(result1).to.be.lt(FIELD_SIZE);
      expect(result1).to.be.gt(0n);
    });
  }

  // -------------------------------------------------------------------------
  // view functions after N deposits — getStats returns correct counts (10 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`after ${n} deposits: getStats returns correct counts`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 300 + n * 12);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const [totalDeposited, totalWithdrawn, depositCount, withdrawalCount, poolBalance] =
        await mixer.getStats();

      expect(depositCount).to.equal(n);
      expect(withdrawalCount).to.equal(0n);
      expect(totalDeposited).to.equal(BigInt(n) * DENOMINATION);
      expect(totalWithdrawn).to.equal(0n);
      expect(poolBalance).to.equal(BigInt(n) * DENOMINATION);
    });
  }

  // -------------------------------------------------------------------------
  // anonymitySetSize tracking (10 tests — 5 deposit-only, 5 deposit+withdraw)
  // -------------------------------------------------------------------------

  for (let deposits = 1; deposits <= 5; deposits++) {
    it(`${deposits} deposits, 0 withdrawals: anonymitySet == ${deposits}`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let j = 0; j < deposits; j++) {
        const c = indexedCommitment(j + 400 + deposits * 10);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      expect(await mixer.getAnonymitySetSize()).to.equal(deposits);
    });

    it(`${deposits} deposits, ${deposits} withdrawals: anonymitySet == 0`, async function () {
      const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);

      for (let j = 0; j < deposits; j++) {
        const c = indexedCommitment(j + 500 + deposits * 10);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const root = await mixer.getLastRoot();

      for (let j = 0; j < deposits; j++) {
        const nullifier = BigInt(ethers.id(`nullifier-anonset-${deposits}-${j}`));
        await doWithdraw(
          mixer,
          root,
          nullifier,
          await recipient.getAddress(),
          ethers.ZeroAddress,
          0n,
          user1
        );
      }

      expect(await mixer.getAnonymitySetSize()).to.equal(0);
    });
  }

  // -------------------------------------------------------------------------
  // commitment field bounds (10 tests)
  // -------------------------------------------------------------------------

  const validCommitmentValues: bigint[] = [
    1n,
    2n,
    100n,
    1000n,
    2n ** 128n,
    2n ** 200n,
    2n ** 250n,
    FIELD_SIZE - 3n,
    FIELD_SIZE - 2n,
    FIELD_SIZE - 1n,
  ];

  for (let idx = 0; idx < validCommitmentValues.length; idx++) {
    const v = validCommitmentValues[idx];
    it(`commitment at bounds index ${idx} (${v.toString().slice(0, 15)}...): deposit succeeds`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      await mixer.connect(user1).deposit(v, { value: DENOMINATION });

      expect(await mixer.commitments(v)).to.equal(true);
      expect(await mixer.getDepositCount()).to.equal(1);
    });
  }

  // -------------------------------------------------------------------------
  // MixerLens snapshot after various states (10 tests)
  // -------------------------------------------------------------------------

  for (let state = 0; state < 10; state++) {
    it(`lens snapshot correct at state ${state} (${state} deposits)`, async function () {
      const { mixer, lens, user1 } = await loadFixture(deployMixerWithLensFixture);

      for (let j = 0; j < state; j++) {
        const c = indexedCommitment(j + 600 + state * 5);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const snapshot = await lens.getSnapshot(await mixer.getAddress());

      expect(snapshot.depositCount).to.equal(state);
      expect(snapshot.totalDeposited).to.equal(BigInt(state) * DENOMINATION);
      expect(snapshot.withdrawalCount).to.equal(0n);
      expect(snapshot.denomination).to.equal(DENOMINATION);
      expect(snapshot.isPaused).to.equal(false);
      expect(snapshot.poolBalance).to.equal(BigInt(state) * DENOMINATION);
      expect(snapshot.anonymitySetSize).to.equal(state);
    });
  }

  // -------------------------------------------------------------------------
  // Receipt sequential minting (10 tests)
  // -------------------------------------------------------------------------

  for (let tokenId = 0; tokenId < 10; tokenId++) {
    it(`receipt tokenId ${tokenId}: ownerOf and commitment correct`, async function () {
      const { mixer, receipt, user1 } = await loadFixture(deployMixerWithReceiptFixture);

      const commitmentList: bigint[] = [];
      for (let j = 0; j <= tokenId; j++) {
        const c = indexedCommitment(j + 700 + tokenId * 3);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
        commitmentList.push(c);
      }

      // Token IDs are 0-indexed: tokenId is the last minted
      expect(await receipt.ownerOf(tokenId)).to.equal(await user1.getAddress());
      const stored = await receipt.tokenCommitment(tokenId);
      expect(stored).to.equal(commitmentList[tokenId]);
    });
  }

  // -------------------------------------------------------------------------
  // commitmentIndex / indexToCommitment round-trip (10 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`commitmentIndex round-trip for ${n} deposits`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      const commitmentList: bigint[] = [];
      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 800 + n * 11);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
        commitmentList.push(c);
      }

      for (let j = 0; j < n; j++) {
        const idx = await mixer.commitmentIndex(commitmentList[j]);
        expect(idx).to.equal(j);
        expect(await mixer.indexToCommitment(j)).to.equal(commitmentList[j]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // depositsPerAddress tracking across multiple addresses (5 tests)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 5; n++) {
    it(`depositsPerAddress tracks correctly for ${n} deposits from same address`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 900 + n * 7);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      expect(await mixer.depositsPerAddress(await user1.getAddress())).to.equal(n);
    });
  }

  // -------------------------------------------------------------------------
  // getPoolHealth consistency across deposit counts (5 tests)
  // -------------------------------------------------------------------------

  for (let n = 0; n < 5; n++) {
    it(`getPoolHealth consistent with getStats after ${n} deposits`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let j = 0; j < n; j++) {
        const c = indexedCommitment(j + 1000 + n * 9);
        await mixer.connect(user1).deposit(c, { value: DENOMINATION });
      }

      const [anonymitySetSize, , poolBalance, isPaused] = await mixer.getPoolHealth();
      const [, , , , statsBalance] = await mixer.getStats();

      expect(anonymitySetSize).to.equal(n);
      expect(poolBalance).to.equal(statsBalance);
      expect(isPaused).to.equal(false);
    });
  }

  // -------------------------------------------------------------------------
  // verifyCommitment matches hashLeftRight (5 tests)
  // -------------------------------------------------------------------------

  const verifyPairs: [bigint, bigint][] = [
    [1n, 2n],
    [100n, 200n],
    [999n, 888n],
    [2n ** 100n, 2n ** 100n + 1n],
    [FIELD_SIZE - 1n, FIELD_SIZE - 2n],
  ];

  for (const [secret, nullifier] of verifyPairs) {
    it(`verifyCommitment(${secret.toString().slice(0, 8)}, ${nullifier.toString().slice(0, 8)}) matches hashLeftRight`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);

      const fromVerify = await mixer.verifyCommitment(secret, nullifier);
      const fromHash = await mixer.hashLeftRight(secret, nullifier);

      expect(fromVerify).to.equal(fromHash);
    });
  }
});
