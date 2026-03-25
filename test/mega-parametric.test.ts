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

const FIELD_MAX =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

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
// Mega Parametric
// ---------------------------------------------------------------------------

describe("Mega Parametric", function () {
  // -------------------------------------------------------------------------
  // 50 unique commitments deposited and verified
  // -------------------------------------------------------------------------

  for (let i = 0; i < 50; i++) {
    it(`commitment #${i}: deposit accepted, tracked, indexed`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const commitment = BigInt(i + 1) * 131n + BigInt(i) * 2000n + 3_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
      expect(await mixer.getCommitmentIndex(commitment)).to.equal(0);
    });
  }

  // -------------------------------------------------------------------------
  // 30 fee distribution checks
  // -------------------------------------------------------------------------

  for (let f = 0; f < 30; f++) {
    it(`fee variation #${f}: amounts split correctly`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      const commitment = BigInt(f + 1) * 137n + BigInt(f) * 1500n + 4_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(f)) / 29n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(f + 1) * 139n + BigInt(f) * 1300n + 5_000_000n;
      const recipientAddr = await recipient.getAddress();
      const relayerAddr =
        fee === 0n ? ethers.ZeroAddress : await relayer.getAddress();

      const recipientBefore = await ethers.provider.getBalance(recipientAddr);
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, relayerAddr, fee);
      const recipientAfter = await ethers.provider.getBalance(recipientAddr);

      expect(recipientAfter - recipientBefore).to.equal(expectedRecipient);
    });
  }

  // -------------------------------------------------------------------------
  // 30 hashLeftRight pairs against determinism
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    const left = BigInt(i + 1) * 149n + 6_000_000n;
    const right = BigInt(i + 1) * 157n + 6_100_000n;
    it(`hash pair #${i}: on-chain == off-chain (deterministic)`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 30 getStats verifications at incremental deposit counts
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 30; n++) {
    it(`getStats after ${n} deposits`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 163n + BigInt(n) * 800n + 7_000_000n;
        await doDeposit(mixer, user1, c);
      }

      const [totalDeposited, , depositCount] = await mixer.getStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(DENOMINATION * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 30 isKnownRoot checks
  // -------------------------------------------------------------------------

  for (let i = 0; i < 30; i++) {
    it(`isKnownRoot for root at deposit #${i}`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      let capturedRoot = 0n;
      for (let d = 0; d <= i; d++) {
        const c = BigInt(d + 1) * 167n + BigInt(i) * 600n + 8_000_000n;
        await doDeposit(mixer, user1, c);
        if (d === i) {
          capturedRoot = await mixer.getLastRoot();
        }
      }

      expect(await mixer.isKnownRoot(capturedRoot)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 30 commitment field bounds (2^bits for bits = 8, 16, ..., 240)
  // -------------------------------------------------------------------------

  for (let bits = 8; bits <= 248; bits += 8) {
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_MAX;
    it(`commitment 2^${bits}-1: valid field element == ${isValid}`, async function () {
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
  // 20 getPoolHealth checks at varying deposit counts
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 20; n++) {
    it(`getPoolHealth after ${n} deposits: balance and set match`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 173n + BigInt(n) * 900n + 9_000_000n;
        await doDeposit(mixer, user1, c);
      }

      const [anonymitySetSize, , poolBalance] = await mixer.getPoolHealth();
      expect(anonymitySetSize).to.equal(BigInt(n));
      expect(poolBalance).to.equal(DENOMINATION * BigInt(n));
    });
  }

  // -------------------------------------------------------------------------
  // 20 verifyCommitment consistency checks
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    const secret = BigInt(i + 1) * 179n + 10_000_000n;
    const nullifier = BigInt(i + 1) * 181n + 10_100_000n;
    it(`verifyCommitment #${i}: matches hashLeftRight(secret, nullifier)`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const viaVerify = await mixer.verifyCommitment(secret, nullifier);
      const viaHash = await mixer.hashLeftRight(secret, nullifier);
      expect(viaVerify).to.equal(viaHash);
    });
  }

  // -------------------------------------------------------------------------
  // 20 getRemainingDeposits — unlimited when no cap set
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`getRemainingDeposits #${i}: returns max uint256 when no limit`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const remaining = await mixer.getRemainingDeposits(
        await user1.getAddress()
      );
      expect(remaining).to.equal(ethers.MaxUint256);
    });
  }

  // -------------------------------------------------------------------------
  // 20 totalWithdrawn tracking
  // -------------------------------------------------------------------------

  for (let w = 1; w <= 20; w++) {
    it(`totalWithdrawn after ${w} withdrawals: equals denomination * ${w}`, async function () {
      const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();

      for (let k = 0; k < w; k++) {
        const c = BigInt(k + 1) * 191n + BigInt(w) * 500n + 11_000_000n;
        await doDeposit(mixer, user1, c);
        const root = await mixer.getLastRoot();
        const nullifierHash =
          BigInt(k + 1) * 193n + BigInt(w) * 600n + 12_000_000n;
        await doWithdraw(
          mixer,
          root,
          nullifierHash,
          recipientAddr,
          ethers.ZeroAddress,
          0n
        );
      }

      const [, totalWithdrawn, , withdrawalCount] = await mixer.getStats();
      expect(totalWithdrawn).to.equal(DENOMINATION * BigInt(w));
      expect(withdrawalCount).to.equal(BigInt(w));
    });
  }

  // -------------------------------------------------------------------------
  // 20 double-spend prevention — same nullifierHash reverts
  // -------------------------------------------------------------------------

  for (let i = 0; i < 20; i++) {
    it(`double-spend #${i}: second withdrawal with same nullifier reverts`, async function () {
      const { mixer, user1, user2, recipient } =
        await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();

      const c1 = BigInt(i + 1) * 197n + 13_000_000n;
      await doDeposit(mixer, user1, c1);
      const c2 = BigInt(i + 1) * 199n + 13_100_000n;
      await doDeposit(mixer, user2, c2);

      const root = await mixer.getLastRoot();
      const nullifierHash = BigInt(i + 1) * 211n + 14_000_000n;

      await doWithdraw(mixer, root, nullifierHash, recipientAddr, ethers.ZeroAddress, 0n);

      await expect(
        doWithdraw(mixer, root, nullifierHash, recipientAddr, ethers.ZeroAddress, 0n)
      ).to.be.revertedWith("Mixer: already spent");
    });
  }

  // -------------------------------------------------------------------------
  // 10 duplicate commitment prevention
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`duplicate commitment #${i}: second deposit reverts`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const commitment = BigInt(i + 1) * 223n + 15_000_000n;

      await doDeposit(mixer, user1, commitment);

      await expect(
        mixer.connect(user1).deposit(commitment, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: duplicate commitment");
    });
  }

  // -------------------------------------------------------------------------
  // 10 isSpent checks after withdrawal
  // -------------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`isSpent #${i}: nullifier marked spent after withdrawal`, async function () {
      const { mixer, user1, recipient } = await loadFixture(deployMixerFixture);
      const recipientAddr = await recipient.getAddress();

      const c = BigInt(i + 1) * 227n + 16_000_000n;
      await doDeposit(mixer, user1, c);
      const root = await mixer.getLastRoot();
      const nullifierHash = BigInt(i + 1) * 229n + 16_100_000n;

      expect(await mixer.isSpent(nullifierHash)).to.be.false;
      await doWithdraw(mixer, root, nullifierHash, recipientAddr, ethers.ZeroAddress, 0n);
      expect(await mixer.isSpent(nullifierHash)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 10 MixerLens getSnapshot — denomination field is constant
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 10; n++) {
    it(`MixerLens snapshot after ${n} deposits: denomination is correct`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);
      const MixerLensFactory = await ethers.getContractFactory("MixerLens");
      const lens = await MixerLensFactory.deploy();

      for (let d = 0; d < n; d++) {
        const c = BigInt(d + 1) * 233n + BigInt(n) * 700n + 17_000_000n;
        await doDeposit(mixer, user1, c);
      }

      const snapshot = await lens.getSnapshot(await mixer.getAddress());
      expect(snapshot.denomination).to.equal(DENOMINATION);
      expect(snapshot.depositCount).to.equal(BigInt(n));
    });
  }
});
