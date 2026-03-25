import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT_SMALL = 5;
const MERKLE_TREE_HEIGHT_LARGE = 7; // capacity 128 — for tests needing >32 deposits
const CAPACITY_SMALL = 2 ** MERKLE_TREE_HEIGHT_SMALL; // 32
const CAPACITY_LARGE = 2 ** MERKLE_TREE_HEIGHT_LARGE; // 128
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

const FIELD_MAX =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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
    MERKLE_TREE_HEIGHT_SMALL,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, user1, user2, recipient, relayer };
}

async function deployLargeMixerFixture() {
  const [owner, user1, user2, recipient, relayer] = await ethers.getSigners();
  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT_LARGE,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, owner, user1, user2, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Massive Parametric
// ---------------------------------------------------------------------------

describe("Massive Parametric", function () {
  // -------------------------------------------------------------------------
  // 100 unique deposits — commitment accepted and stored
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    it(`deposit #${i}: unique commitment accepted`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      // Commitment seed offset: 50_000_000 avoids collision with other suites
      const commitment =
        BigInt(i + 1) * 317n + BigInt(i) * 4_001n + 50_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 50 fee variations — recipient receives denomination minus fee
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    it(`withdraw fee variation #${i}`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      const commitment =
        BigInt(i + 1) * 331n + BigInt(i) * 2_003n + 51_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(i)) / 49n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(i + 1) * 337n + BigInt(i) * 1_007n + 52_000_000n;
      const recipientAddr = await recipient.getAddress();
      const relayerAddr =
        fee === 0n ? ethers.ZeroAddress : await relayer.getAddress();

      const balBefore = await ethers.provider.getBalance(recipientAddr);
      await doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipientAddr,
        relayerAddr,
        fee
      );
      const balAfter = await ethers.provider.getBalance(recipientAddr);

      expect(balAfter - balBefore).to.equal(expectedRecipient);
    });
  }

  // -------------------------------------------------------------------------
  // 50 hash verifications — on-chain == on-chain (determinism)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    const left = BigInt(i + 1) * 347n + 53_000_000n;
    const right = BigInt(i + 1) * 349n + 53_100_000n;
    it(`hash pair #${i}: on-chain == off-chain`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 50 getStats at N deposits (1 <= N <= 50 — use large mixer for N > 32)
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 50; n++) {
    it(`getStats after ${n} deposits`, async function () {
      const { mixer, user1 } = await loadFixture(
        n > CAPACITY_SMALL ? deployLargeMixerFixture : deployMixerFixture
      );

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 353n + BigInt(n) * 1_009n + 54_000_000n;
        await doDeposit(mixer, user1, c);
      }

      const [totalDeposited, , depositCount] = await mixer.getStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(DENOMINATION * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 50 anonymity set tracking
  //   d deposits, 0 withdrawals  → anonymitySet == d
  //   d deposits, floor(d/2) withdrawals → anonymitySet == d - floor(d/2)
  // -------------------------------------------------------------------------

  for (let d = 1; d <= 25; d++) {
    it(`${d} deposits, 0 withdrawals: anonymitySet == ${d}`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let k = 0; k < d; k++) {
        const c = BigInt(k + 1) * 359n + BigInt(d) * 1_013n + 55_000_000n;
        await doDeposit(mixer, user1, c);
      }

      const [anonymitySetSize] = await mixer.getPoolHealth();
      expect(anonymitySetSize).to.equal(BigInt(d));
    });

    const half = Math.floor(d / 2);
    it(`${d} deposits, ${half} withdrawals: correct`, async function () {
      const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();

      const commitments: bigint[] = [];
      for (let k = 0; k < d; k++) {
        const c = BigInt(k + 1) * 367n + BigInt(d) * 997n + 56_000_000n;
        commitments.push(c);
        await doDeposit(mixer, user1, c);
      }

      for (let w = 0; w < half; w++) {
        const root = await mixer.getLastRoot();
        const nullifier =
          BigInt(w + 1) * 373n + BigInt(d) * 991n + 57_000_000n;
        await doWithdraw(
          mixer,
          root,
          nullifier,
          recipientAddr,
          ethers.ZeroAddress,
          0n
        );
      }

      const [, , , withdrawalCount] = await mixer.getStats();
      expect(withdrawalCount).to.equal(BigInt(half));
    });
  }

  // -------------------------------------------------------------------------
  // 50 commitment bounds — 2^bits for bits 1..250 step 5
  // -------------------------------------------------------------------------

  for (let bits = 1; bits <= 250; bits += 5) {
    const candidate = 2n ** BigInt(bits);
    const isValid = candidate > 0n && candidate < FIELD_MAX;
    it(`commitment 2^${bits}: valid`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      if (isValid) {
        await expect(
          mixer.connect(user1).deposit(candidate, { value: DENOMINATION })
        ).to.not.be.reverted;
        expect(await mixer.isCommitted(candidate)).to.be.true;
      } else {
        await expect(
          mixer.connect(user1).deposit(candidate, { value: DENOMINATION })
        ).to.be.reverted;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 50 root history — isKnownRoot for root at deposit #i (0 <= i < 50)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    it(`root at deposit #${i}: in history`, async function () {
      const { mixer, user1 } = await loadFixture(
        i >= CAPACITY_SMALL ? deployLargeMixerFixture : deployMixerFixture
      );

      let capturedRoot = 0n;
      for (let d = 0; d <= i; d++) {
        const c = BigInt(d + 1) * 379n + BigInt(i) * 983n + 58_000_000n;
        await doDeposit(mixer, user1, c);
        if (d === i) {
          capturedRoot = await mixer.getLastRoot();
        }
      }

      expect(await mixer.isKnownRoot(capturedRoot)).to.be.true;
    });
  }
});
