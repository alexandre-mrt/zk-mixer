import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5; // capacity = 32
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

async function deployTeraMixerFixture() {
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
// Tera Parametric
// ---------------------------------------------------------------------------

describe("Tera Parametric", function () {
  // -------------------------------------------------------------------------
  // 5 deposit cycles — commitment stored (tree height 5, capacity 32)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`deposit #${i}: accepted`, async function () {
      const { mixer, user1 } = await loadFixture(deployTeraMixerFixture);
      // Use distinct primes to avoid commitment collision across iterations
      const commitment =
        BigInt(i + 1) * 383n + BigInt(i) * 5_000n + 70_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 5 fee splits — recipient receives denomination minus fee
  // -------------------------------------------------------------------------

  for (let f = 0; f < 5; f++) {
    it(`fee split #${f}`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployTeraMixerFixture);

      const commitment =
        BigInt(f + 1) * 389n + BigInt(f) * 4_800n + 71_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(f)) / 4n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(f + 1) * 397n + BigInt(f) * 4_600n + 72_000_000n;
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
  // 5 hash pairs — deterministic on-chain Poseidon
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    const left = BigInt(i + 1) * 401n + 73_000_000n;
    const right = BigInt(i + 1) * 409n + 73_100_000n;
    it(`hash #${i}: consistent`, async function () {
      const { mixer } = await loadFixture(deployTeraMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 5 commitment bounds — field element validation
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    const bits = 10 + i * 2; // 10, 12, 14, …, 208
    const candidate = 2n ** BigInt(bits) - 1n;
    const isValid = candidate > 0n && candidate < FIELD_MAX;
    it(`bound #${i}`, async function () {
      const { mixer, user1 } = await loadFixture(deployTeraMixerFixture);

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
});
