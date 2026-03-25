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

async function deployZettaMixerFixture() {
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
// Zetta Parametric
// Primes/offsets: 709n, 719n, 727n, 733n
// Seed bases: 200_000_000n+ (well above highest prior suite at 104_000_000n)
// Tree height 5 — capacity 32
// ---------------------------------------------------------------------------

describe("Zetta Parametric", function () {
  // -------------------------------------------------------------------------
  // 5 deposit-check tests — commitment stored after deposit
  // Base offset: 200_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`deposit-check #${i}`, async function () {
      const { mixer, user1 } = await loadFixture(deployZettaMixerFixture);
      const commitment =
        BigInt(i + 1) * 709n + BigInt(i) * 7_090n + 200_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 5 hash-verify tests — on-chain Poseidon is deterministic + in-field
  // Base offset: 201_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    const left = BigInt(i + 1) * 719n + 201_000_000n;
    const right = BigInt(i + 1) * 727n + 201_100_000n;
    it(`hash-verify #${i}`, async function () {
      const { mixer } = await loadFixture(deployZettaMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 5 fee-split tests — recipient receives denomination minus fee
  // Base offset: 202_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    it(`fee-split #${i}`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployZettaMixerFixture);

      const commitment =
        BigInt(i + 1) * 733n + BigInt(i) * 6_800n + 202_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(i)) / 4n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(i + 1) * 739n + BigInt(i) * 6_600n + 203_000_000n;
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
  // 5 bound-check tests — valid field elements accepted as commitments
  // Base offset: 204_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 5; i++) {
    const commitment = BigInt(i + 1) * 743n + BigInt(i) * 6_400n + 204_000_000n;
    it(`bound-check #${i}`, async function () {
      const { mixer, user1 } = await loadFixture(deployZettaMixerFixture);

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
    });
  }
});
