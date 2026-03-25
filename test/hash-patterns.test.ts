import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildPoseidon } from "circomlibjs";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// BN254 scalar field prime — all Poseidon inputs/outputs are in [0, FIELD_SIZE).
const FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Return a 31-byte random bigint, guaranteed to stay below FIELD_SIZE. */
function randomField(): bigint {
  return ethers.toBigInt(ethers.randomBytes(31));
}

/** Deploy a fresh Mixer and return it. */
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

// -------------------------------------------------------------------------
// Suite
// -------------------------------------------------------------------------

describe("Hash Consistency Patterns", function () {
  // circomlibjs Poseidon instance — built once for the whole suite.
  let poseidon: Awaited<ReturnType<typeof buildPoseidon>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let F: any;

  before(async function () {
    poseidon = await buildPoseidon();
    F = poseidon.F;
  });

  // Helper: compute off-chain Poseidon(left, right) as a bigint.
  function offChain(left: bigint, right: bigint): bigint {
    return F.toObject(poseidon([left, right]));
  }

  // -----------------------------------------------------------------------
  // 1. hash(0, 0) is non-zero
  // -----------------------------------------------------------------------

  it("hash(0, 0) is non-zero", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const result = await mixer.hashLeftRight(0n, 0n);
    expect(result).to.not.equal(0n);
  });

  // -----------------------------------------------------------------------
  // 2. hash(a, b) != hash(b, a) for distinct a, b
  // -----------------------------------------------------------------------

  it("hash(a, b) != hash(b, a) for distinct a, b", async function () {
    const { mixer } = await loadFixture(deployFixture);

    // Use fixed distinct values so the assertion is deterministic.
    const a = 1n;
    const b = 2n;

    const ab = await mixer.hashLeftRight(a, b);
    const ba = await mixer.hashLeftRight(b, a);

    expect(ab).to.not.equal(ba);
  });

  // -----------------------------------------------------------------------
  // 3. hash is deterministic across transactions
  // -----------------------------------------------------------------------

  it("hash is deterministic across transactions", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const left = randomField();
    const right = randomField();

    // Two separate on-chain calls must return the same value.
    const first = await mixer.hashLeftRight(left, right);
    const second = await mixer.hashLeftRight(left, right);

    expect(first).to.equal(second);
  });

  // -----------------------------------------------------------------------
  // 4. hash(x, 0) != hash(0, x)
  // -----------------------------------------------------------------------

  it("hash(x, 0) != hash(0, x)", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const x = 42n;

    const xZero = await mixer.hashLeftRight(x, 0n);
    const zeroX = await mixer.hashLeftRight(0n, x);

    expect(xZero).to.not.equal(zeroX);
  });

  // -----------------------------------------------------------------------
  // 5. hash of large values near FIELD_SIZE boundary
  // -----------------------------------------------------------------------

  it("hash of large values near FIELD_SIZE boundary", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const fieldMax = FIELD_SIZE - 1n;
    const nearMax = FIELD_SIZE - 2n;

    const onChain = await mixer.hashLeftRight(fieldMax, nearMax);
    const expected = offChain(fieldMax, nearMax);

    expect(onChain).to.equal(expected);
    // Output must itself be a valid field element.
    expect(onChain).to.be.lessThan(FIELD_SIZE);
  });

  // -----------------------------------------------------------------------
  // 6. hash of sequential values (i, i+1) are all distinct
  // -----------------------------------------------------------------------

  it("hash of sequential values (i, i+1) are all distinct", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const COUNT = 8;
    const results: bigint[] = [];

    for (let i = 0; i < COUNT; i++) {
      const h = await mixer.hashLeftRight(BigInt(i), BigInt(i + 1));
      results.push(h);
    }

    const unique = new Set(results.map(String));
    expect(unique.size).to.equal(COUNT);
  });

  // -----------------------------------------------------------------------
  // 7. on-chain hash matches circomlibjs for 10 random pairs
  // -----------------------------------------------------------------------

  for (let i = 0; i < 10; i++) {
    it(`on-chain hash matches circomlibjs for random pair #${i + 1}`, async function () {
      const { mixer } = await loadFixture(deployFixture);

      const left = randomField();
      const right = randomField();

      const onChain = await mixer.hashLeftRight(left, right);
      const expected = offChain(left, right);

      expect(onChain).to.equal(expected);
    });
  }

  // -----------------------------------------------------------------------
  // 8. empty tree root matches hash chain of zeros
  // -----------------------------------------------------------------------

  it("empty tree root matches hash chain of zeros", async function () {
    const { mixer } = await loadFixture(deployFixture);

    // Re-derive the empty-tree root off-chain:
    //   zeros[0] = 0
    //   zeros[i+1] = Poseidon(zeros[i], zeros[i])
    let currentZero = 0n;
    for (let i = 0; i < MERKLE_TREE_HEIGHT; i++) {
      currentZero = offChain(currentZero, currentZero);
    }

    const onChainRoot = await mixer.getLastRoot();

    expect(onChainRoot).to.equal(currentZero);
  });

  // -----------------------------------------------------------------------
  // 9. root after 1 deposit matches manual hash computation
  // -----------------------------------------------------------------------

  it("root after 1 deposit matches manual hash computation", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const [, depositor] = await ethers.getSigners();

    // Choose a deterministic non-zero leaf.
    const leaf = 7777n;

    await mixer.connect(depositor).deposit(leaf, { value: DENOMINATION });

    const onChainRoot = await mixer.getLastRoot();

    // Manual computation for a depth-5 tree after inserting leaf at index 0:
    //
    //   zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
    //
    // At level i the inserted path is always a left child (index 0 is even
    // at every level), so the right sibling is zeros[i].
    //
    //   level0Hash = leaf
    //   level1Hash = Poseidon(level0Hash, zeros[0])   — zeros[0] = 0
    //   level2Hash = Poseidon(level1Hash, zeros[1])
    //   ...
    //   root       = Poseidon(level(N-1)Hash, zeros[N-1])

    // Build zeros array: zeros[i] = Poseidon^i(0, 0)
    const zeros: bigint[] = [0n];
    for (let i = 1; i <= MERKLE_TREE_HEIGHT; i++) {
      zeros.push(offChain(zeros[i - 1], zeros[i - 1]));
    }

    let current = leaf;
    for (let i = 0; i < MERKLE_TREE_HEIGHT; i++) {
      // index 0 is always a left child at every level
      current = offChain(current, zeros[i]);
    }

    expect(onChainRoot).to.equal(current);
  });

  // -----------------------------------------------------------------------
  // 10. hash output is always less than FIELD_SIZE
  // -----------------------------------------------------------------------

  it("hash output is always less than FIELD_SIZE", async function () {
    const { mixer } = await loadFixture(deployFixture);

    // Test a representative set of inputs: zero, one, max, and a mid-range value.
    const fieldMax = FIELD_SIZE - 1n;
    const inputs: Array<[bigint, bigint]> = [
      [0n, 0n],
      [1n, 0n],
      [0n, 1n],
      [1n, 1n],
      [fieldMax, 0n],
      [0n, fieldMax],
      [fieldMax, fieldMax],
      [randomField(), randomField()],
    ];

    for (const [left, right] of inputs) {
      const result = await mixer.hashLeftRight(left, right);
      expect(result, `hash(${left}, ${right}) must be < FIELD_SIZE`).to.be.lessThan(
        FIELD_SIZE
      );
    }
  });
});
