import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// BN254 field size prime. All valid inputs must be strictly less than this value.
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

async function deployFixture(): Promise<{ mixer: Mixer }> {
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

  return { mixer };
}

describe("Mixer.verifyCommitment", function () {
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  // ---------------------------------------------------------------------------
  // Returns correct hash
  // ---------------------------------------------------------------------------

  it("returns the Poseidon hash of (secret, nullifier)", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const secret = ethers.toBigInt(ethers.randomBytes(31));
    const nullifier = ethers.toBigInt(ethers.randomBytes(31));

    const result = await mixer.verifyCommitment(secret, nullifier);

    expect(typeof result).to.equal("bigint");
    expect(result).to.be.greaterThan(0n);
    expect(result).to.be.lessThan(FIELD_SIZE);
  });

  // ---------------------------------------------------------------------------
  // Matches off-chain Poseidon
  // ---------------------------------------------------------------------------

  it("matches the off-chain circomlibjs Poseidon(secret, nullifier)", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const secret = ethers.toBigInt(ethers.randomBytes(31));
    const nullifier = ethers.toBigInt(ethers.randomBytes(31));

    const onChain = await mixer.verifyCommitment(secret, nullifier);
    const offChain = F.toObject(poseidon([secret, nullifier]));

    expect(onChain).to.equal(offChain);
  });

  // ---------------------------------------------------------------------------
  // Deterministic
  // ---------------------------------------------------------------------------

  it("is deterministic — same inputs always return the same commitment", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const secret = 12345678901234567890n;
    const nullifier = 98765432109876543210n;

    const first = await mixer.verifyCommitment(secret, nullifier);
    const second = await mixer.verifyCommitment(secret, nullifier);

    expect(first).to.equal(second);
  });

  // ---------------------------------------------------------------------------
  // Additional consistency checks
  // ---------------------------------------------------------------------------

  it("is consistent with hashLeftRight(secret, nullifier)", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const secret = ethers.toBigInt(ethers.randomBytes(31));
    const nullifier = ethers.toBigInt(ethers.randomBytes(31));

    const fromVerify = await mixer.verifyCommitment(secret, nullifier);
    const fromHash = await mixer.hashLeftRight(secret, nullifier);

    expect(fromVerify).to.equal(fromHash);
  });

  it("is not commutative — verifyCommitment(a, b) != verifyCommitment(b, a) for distinct inputs", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const a = ethers.toBigInt(ethers.randomBytes(31)) + 1n;
    const b = a + 1n;

    const ab = await mixer.verifyCommitment(a, b);
    const ba = await mixer.verifyCommitment(b, a);

    expect(ab).to.not.equal(ba);
  });

  it("reverts when secret >= FIELD_SIZE", async function () {
    const { mixer } = await loadFixture(deployFixture);

    await expect(mixer.verifyCommitment(FIELD_SIZE, 1n)).to.be.revertedWith(
      "MerkleTree: left overflow"
    );
  });

  it("reverts when nullifier >= FIELD_SIZE", async function () {
    const { mixer } = await loadFixture(deployFixture);

    await expect(mixer.verifyCommitment(1n, FIELD_SIZE)).to.be.revertedWith(
      "MerkleTree: right overflow"
    );
  });
});
