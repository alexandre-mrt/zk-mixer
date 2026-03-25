import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 7; // capacity = 128 (supports up to 100 deposits)
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
// Hyper Parametric
// ---------------------------------------------------------------------------

describe("Hyper Parametric", function () {
  // -------------------------------------------------------------------------
  // 100 commitment field element tests — sweeping bit widths 1..253
  // Step = floor(253/100) = 2, so bits: 1, 3, 5, ... up to ~201
  // -------------------------------------------------------------------------

  for (let bits = 1; bits <= 201; bits += 2) {
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_MAX;
    it(`commitment at bit-width ${bits}: valid deposit == ${isValid}`, async function () {
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
  // 100 fee splits: 0% to 99% of denomination
  // -------------------------------------------------------------------------

  for (let pct = 0; pct <= 99; pct++) {
    it(`withdraw with ${pct}% fee: recipient and relayer balances correct`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployMixerFixture);

      const commitment =
        BigInt(pct + 1) * 311n + BigInt(pct) * 2100n + 50_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(pct)) / 100n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(pct + 1) * 313n + BigInt(pct) * 1900n + 51_000_000n;
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
  // 100 hash pair determinism checks
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const left = BigInt(i + 1) * 317n + 52_000_000n;
    const right = BigInt(i + 1) * 331n + 52_100_000n;
    it(`hash pair #${i}: deterministic and matches off-chain`, async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 100 getStats consistency checks — deposit #n: stats consistent
  // Uses tree height 7 (capacity 128) to accommodate all 100 deposits
  // -------------------------------------------------------------------------

  for (let n = 1; n <= 100; n++) {
    it(`deposit #${n}: stats consistent`, async function () {
      const { mixer, user1 } = await loadFixture(deployMixerFixture);

      for (let d = 0; d < n; d++) {
        const c =
          BigInt(d + 1) * 337n + BigInt(n) * 500n + 53_000_000n;
        await doDeposit(mixer, user1, c);
      }

      const [totalDeposited, , depositCount] = await mixer.getStats();
      expect(depositCount).to.equal(BigInt(n));
      expect(totalDeposited).to.equal(DENOMINATION * BigInt(n));
    });
  }
});
