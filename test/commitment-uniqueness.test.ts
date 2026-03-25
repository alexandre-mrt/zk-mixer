import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// BN254 scalar field prime — all Poseidon inputs/outputs live in [0, FIELD_SIZE).
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const FIELD_MAX = FIELD_SIZE - 1n;

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a 31-byte random bigint, guaranteed to stay strictly below FIELD_SIZE. */
function randomField(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Commitment Uniqueness", function () {
  // circomlibjs Poseidon instance — built once for the whole suite.
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  /** Compute commitment = Poseidon(secret, nullifier) off-chain. */
  function commitment(secret: bigint, nullifier: bigint): bigint {
    return F.toObject(poseidon([secret, nullifier]));
  }

  /** Compute nullifierHash = Poseidon(nullifier) off-chain. */
  function nullifierHash(nullifier: bigint): bigint {
    return F.toObject(poseidon([nullifier]));
  }

  // -------------------------------------------------------------------------
  // 1. Two random commitments are distinct
  // -------------------------------------------------------------------------

  it("two random commitments are distinct", function () {
    const c1 = commitment(randomField(), randomField());
    const c2 = commitment(randomField(), randomField());

    // With overwhelming probability two independent random 31-byte inputs
    // produce different Poseidon outputs; a collision would break the hash.
    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 2. 100 random commitments have no collisions
  // -------------------------------------------------------------------------

  it("100 random commitments are all unique (no collisions)", function () {
    const commitments: bigint[] = [];
    for (let i = 0; i < 100; i++) {
      commitments.push(commitment(randomField(), randomField()));
    }

    const unique = new Set(commitments.map(String));
    expect(unique.size).to.equal(100);
  });

  // -------------------------------------------------------------------------
  // 3. Changing secret changes commitment
  // -------------------------------------------------------------------------

  it("commitment = Poseidon(secret, nullifier) — changing secret changes commitment", function () {
    const nullifier = randomField();
    const secret1 = randomField();
    const secret2 = secret1 + 1n;

    const c1 = commitment(secret1, nullifier);
    const c2 = commitment(secret2, nullifier);

    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 4. Changing nullifier changes commitment
  // -------------------------------------------------------------------------

  it("commitment = Poseidon(secret, nullifier) — changing nullifier changes commitment", function () {
    const secret = randomField();
    const nullifier1 = randomField();
    const nullifier2 = nullifier1 + 1n;

    const c1 = commitment(secret, nullifier1);
    const c2 = commitment(secret, nullifier2);

    expect(c1).to.not.equal(c2);
  });

  // -------------------------------------------------------------------------
  // 5. Same commitment cannot be deposited twice
  // -------------------------------------------------------------------------

  it("same commitment cannot be deposited twice", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const [, depositor] = await ethers.getSigners();

    const c = commitment(randomField(), randomField());

    await mixer.connect(depositor).deposit(c, { value: DENOMINATION });

    await expect(
      mixer.connect(depositor).deposit(c, { value: DENOMINATION })
    ).to.be.revertedWith("Mixer: duplicate commitment");
  });

  // -------------------------------------------------------------------------
  // 6. Commitments at field boundaries are valid but distinct
  // -------------------------------------------------------------------------

  it("commitment 1 and FIELD_SIZE-1 are both valid but different", function () {
    // Commitment values are field elements; 1n and FIELD_MAX are the
    // smallest and largest valid non-zero inputs to Poseidon.
    const c1 = commitment(1n, 1n);
    const cMax = commitment(FIELD_MAX, FIELD_MAX);

    expect(c1).to.not.equal(cMax);
    // Both must be valid field elements.
    expect(c1).to.be.lessThan(FIELD_SIZE);
    expect(cMax).to.be.lessThan(FIELD_SIZE);
  });

  // -------------------------------------------------------------------------
  // 7. Poseidon is collision-resistant for sequential inputs
  // -------------------------------------------------------------------------

  it("Poseidon hash is collision-resistant for sequential inputs", function () {
    const COUNT = 20;
    const results: bigint[] = [];

    for (let i = 0; i < COUNT; i++) {
      results.push(commitment(BigInt(i), BigInt(i)));
    }

    const unique = new Set(results.map(String));
    expect(unique.size).to.equal(COUNT);
  });

  // -------------------------------------------------------------------------
  // 8. On-chain hashLeftRight matches off-chain for boundary values
  // -------------------------------------------------------------------------

  it("on-chain hashLeftRight matches off-chain for boundary values", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const pairs: [bigint, bigint][] = [
      [1n, 1n],
      [FIELD_MAX, 1n],
      [1n, FIELD_MAX],
      [FIELD_MAX, FIELD_MAX],
    ];

    for (const [left, right] of pairs) {
      const onChain = await mixer.hashLeftRight(left, right);
      const offChain = F.toObject(poseidon([left, right]));
      expect(onChain, `hashLeftRight(${left}, ${right})`).to.equal(offChain);
    }
  });

  // -------------------------------------------------------------------------
  // 9. nullifierHash = Poseidon(nullifier) is distinct per nullifier
  // -------------------------------------------------------------------------

  it("nullifierHash = Poseidon(nullifier) is distinct per nullifier", function () {
    const COUNT = 20;
    const hashes: bigint[] = [];

    for (let i = 0; i < COUNT; i++) {
      hashes.push(nullifierHash(randomField()));
    }

    const unique = new Set(hashes.map(String));
    expect(unique.size).to.equal(COUNT);
  });

  // -------------------------------------------------------------------------
  // 10. nullifierHash for same nullifier is deterministic
  // -------------------------------------------------------------------------

  it("nullifierHash for same nullifier is deterministic", function () {
    const n = randomField();

    const h1 = nullifierHash(n);
    const h2 = nullifierHash(n);

    expect(h1).to.equal(h2);
  });
});
