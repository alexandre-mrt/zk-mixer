import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 9; // capacity = 512
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

async function deployPetaMixerFixture() {
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
// Peta Parametric
// ---------------------------------------------------------------------------

describe("Peta Parametric", function () {
  // -------------------------------------------------------------------------
  // 400 deposit cycles — commitment stored and index correct
  // Primes/offsets: 503n, 509n / base 90_000_000n — distinct from all prior suites
  // -------------------------------------------------------------------------

  for (let i = 0; i < 400; i++) {
    it(`deposit #${i}: stored and indexed`, async function () {
      const { mixer, user1 } = await loadFixture(deployPetaMixerFixture);
      // Distinct primes/offset per suite — no collision with other parametric files
      const commitment =
        BigInt(i + 1) * 503n + BigInt(i) * 6_000n + 90_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 200 Poseidon hash pairs — on-chain output matches itself (determinism)
  // -------------------------------------------------------------------------

  for (let i = 0; i < 200; i++) {
    const left = BigInt(i + 1) * 509n + 91_000_000n;
    const right = BigInt(i + 1) * 521n + 91_100_000n;
    it(`hash match #${i}`, async function () {
      const { mixer } = await loadFixture(deployPetaMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 200 fee split variations — recipient receives denomination minus fee
  // -------------------------------------------------------------------------

  for (let f = 0; f < 200; f++) {
    it(`fee #${f}: correct split`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployPetaMixerFixture);

      const commitment =
        BigInt(f + 1) * 523n + BigInt(f) * 5_500n + 92_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(f)) / 199n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(f + 1) * 541n + BigInt(f) * 5_300n + 93_000_000n;
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
});
