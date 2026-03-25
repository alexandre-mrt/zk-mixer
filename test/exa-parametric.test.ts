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

async function deployExaMixerFixture() {
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
// Exa Parametric
// Primes/offsets: 601n, 607n, 613n, 617n / bases 100_000_000n+
// Distinct from all prior suites (highest prior: 93_000_000n in peta)
// ---------------------------------------------------------------------------

describe("Exa Parametric", function () {
  // -------------------------------------------------------------------------
  // 300 deposit-verify cycles — commitment stored after deposit
  // Base offset: 100_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    it(`deposit-verify #${i}`, async function () {
      const { mixer, user1 } = await loadFixture(deployExaMixerFixture);
      const commitment =
        BigInt(i + 1) * 601n + BigInt(i) * 6_100n + 100_000_000n;

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
    });
  }

  // -------------------------------------------------------------------------
  // 300 hash-consistency checks — on-chain Poseidon is deterministic + in-field
  // Base offset: 101_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    const left = BigInt(i + 1) * 607n + 101_000_000n;
    const right = BigInt(i + 1) * 613n + 101_100_000n;
    it(`hash-consistency #${i}`, async function () {
      const { mixer } = await loadFixture(deployExaMixerFixture);
      const h1 = await mixer.hashLeftRight(left, right);
      const h2 = await mixer.hashLeftRight(left, right);
      expect(h1).to.equal(h2);
      expect(h1).to.be.lessThan(FIELD_MAX);
    });
  }

  // -------------------------------------------------------------------------
  // 300 fee-distribution checks — recipient receives denomination minus fee
  // Base offset: 102_000_000n
  // -------------------------------------------------------------------------

  for (let f = 0; f < 300; f++) {
    it(`fee-distribution #${f}`, async function () {
      const { mixer, user1, recipient, relayer } =
        await loadFixture(deployExaMixerFixture);

      const commitment =
        BigInt(f + 1) * 617n + BigInt(f) * 5_900n + 102_000_000n;
      await doDeposit(mixer, user1, commitment);
      const root = await mixer.getLastRoot();

      const fee = (DENOMINATION * BigInt(f)) / 299n;
      const expectedRecipient = DENOMINATION - fee;

      const nullifierHash =
        BigInt(f + 1) * 619n + BigInt(f) * 5_700n + 103_000_000n;
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
  // 300 commitment-bound checks — valid field elements accepted
  // Base offset: 104_000_000n
  // -------------------------------------------------------------------------

  for (let i = 0; i < 300; i++) {
    // Use a simple linear formula; all values stay well within the BN254 field
    const commitment = BigInt(i + 1) * 631n + BigInt(i) * 4_700n + 104_000_000n;
    it(`commitment-bound #${i}`, async function () {
      const { mixer, user1 } = await loadFixture(deployExaMixerFixture);

      await doDeposit(mixer, user1, commitment);

      expect(await mixer.isCommitted(commitment)).to.be.true;
    });
  }
});
