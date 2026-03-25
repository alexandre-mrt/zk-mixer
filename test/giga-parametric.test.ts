import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 8;
const CAPACITY = 2 ** MERKLE_TREE_HEIGHT; // 256
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

async function deployGigaMixerFixture() {
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
// Giga Parametric
// ---------------------------------------------------------------------------

describe("Giga Parametric", function () {
  // -------------------------------------------------------------------------
  // 200 deposit + commitment verification (tree height 8, capacity 256)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 200; i++) {
    it(`deposit #${i}: commitment stored and indexed`, async function () {
      const { mixer, user1 } = await loadFixture(deployGigaMixerFixture);
      const commitment =
        BigInt(i + 1) * 251n + BigInt(i) * 3_000n + 50_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
      expect(await mixer.getCommitmentIndex(commitment)).to.equal(0);
    });
  }

  // -------------------------------------------------------------------------
  // 100 withdrawal fee splits
  // -------------------------------------------------------------------------

  for (let f = 0; f < 100; f++) {
    it(`fee split #${f}: amounts correct`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployGigaMixerFixture);

      const commitment =
        BigInt(f + 1) * 257n + BigInt(f) * 2_500n + 51_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(f)) / 99n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(f + 1) * 263n + BigInt(f) * 2_200n + 52_000_000n;
      const recipientAddr = await recipient.getAddress();
      const relayerAddr =
        fee === 0n ? ethers.ZeroAddress : await relayer.getAddress();

      const recipientBefore = await ethers.provider.getBalance(recipientAddr);
      await doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipientAddr,
        relayerAddr,
        fee
      );
      const recipientAfter = await ethers.provider.getBalance(recipientAddr);

      expect(recipientAfter - recipientBefore).to.equal(expectedRecipient);
    });
  }

  // -------------------------------------------------------------------------
  // 100 Poseidon hash verifications (on-chain determinism)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 100; i++) {
    const left = BigInt(i + 1) * 269n + 53_000_000n;
    const right = BigInt(i + 1) * 271n + 53_100_000n;
    it(`hash pair #${i}: matches circomlibjs`, async function () {
      const { mixer } = await loadFixture(deployGigaMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }
});
