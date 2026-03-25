import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// Tree height 6 → capacity 64.
// Height 5 (capacity 32) is insufficient: tests require up to 60 deposits
// for double-wrap and 39 for saturation. Height 6 gives capacity 64.
const MERKLE_TREE_HEIGHT = 6;
const ROOT_HISTORY_SIZE = 30;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function deployMixerFixture() {
  const [owner, depositor] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  );

  return { mixer, owner, depositor };
}

async function makeDeposits(
  mixer: Awaited<ReturnType<typeof deployMixerFixture>>["mixer"],
  depositor: Awaited<ReturnType<typeof deployMixerFixture>>["depositor"],
  count: number
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await mixer
      .connect(depositor)
      .deposit(randomCommitment(), { value: DENOMINATION });
  }
}

describe("Root History Ring Buffer", function () {
  it("initial state: currentRootIndex == 0, roots[0] is empty tree root", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);

    const idx = await mixer.currentRootIndex();
    expect(idx).to.equal(0n);

    // roots[0] must be the non-zero empty-tree root stored by the constructor
    const emptyRoot = await mixer.roots(0);
    expect(emptyRoot).to.be.greaterThan(0n);

    // getLastRoot must point to roots[0]
    const lastRoot = await mixer.getLastRoot();
    expect(lastRoot).to.equal(emptyRoot);
  });

  it("after 1 deposit: currentRootIndex == 1", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    await makeDeposits(mixer, depositor, 1);

    expect(await mixer.currentRootIndex()).to.equal(1n);
  });

  it("after 29 deposits: currentRootIndex == 29", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    await makeDeposits(mixer, depositor, 29);

    expect(await mixer.currentRootIndex()).to.equal(29n);
  });

  it("after 30 deposits: currentRootIndex wraps to 0", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    await makeDeposits(mixer, depositor, 30);

    expect(await mixer.currentRootIndex()).to.equal(0n);
  });

  it("after 31 deposits: currentRootIndex == 1 (wrapped)", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    await makeDeposits(mixer, depositor, 31);

    expect(await mixer.currentRootIndex()).to.equal(1n);
  });

  it("all roots within the current window are known", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    // Collect the root after each deposit
    const collectedRoots: bigint[] = [];
    for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
      await mixer
        .connect(depositor)
        .deposit(randomCommitment(), { value: DENOMINATION });
      collectedRoots.push(await mixer.getLastRoot());
    }

    // Every root in the window must be recognised
    for (const root of collectedRoots) {
      expect(await mixer.isKnownRoot(root)).to.equal(
        true,
        `Root ${root} should be known`
      );
    }
  });

  it("root at currentRootIndex - ROOT_HISTORY_SIZE is evicted", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    // Capture the very first root written (after deposit #1 → slot 1)
    await makeDeposits(mixer, depositor, 1);
    const firstDepositRoot = await mixer.getLastRoot();

    // Advance the ring buffer by ROOT_HISTORY_SIZE more deposits so that
    // the slot holding firstDepositRoot is overwritten
    await makeDeposits(mixer, depositor, ROOT_HISTORY_SIZE);

    expect(await mixer.isKnownRoot(firstDepositRoot)).to.equal(false);
  });

  it("getLastRoot always returns roots[currentRootIndex]", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    // Check across several deposits including a wrap-around
    for (let i = 0; i < 35; i++) {
      await mixer
        .connect(depositor)
        .deposit(randomCommitment(), { value: DENOMINATION });

      const idx = await mixer.currentRootIndex();
      const rootAtIdx = await mixer.roots(idx);
      const lastRoot = await mixer.getLastRoot();

      expect(lastRoot).to.equal(
        rootAtIdx,
        `Mismatch at deposit ${i + 1}: getLastRoot != roots[currentRootIndex]`
      );
    }
  });

  it("root history is circular: 60 deposits wraps twice", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    // 60 deposits = exactly 2 full revolutions of a 30-slot ring buffer.
    // Starting at index 0, after 60 deposits: (0 + 60) % 30 = 0.
    await makeDeposits(mixer, depositor, 60);

    expect(await mixer.currentRootIndex()).to.equal(0n);
  });

  it("getRootHistory returns exactly 30 entries", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    await makeDeposits(mixer, depositor, 5);

    const history = await mixer.getRootHistory();
    expect(history.length).to.equal(ROOT_HISTORY_SIZE);
  });

  it("getValidRootCount saturates at 30", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    // Initially roots[0] is set → count is 1
    expect(await mixer.getValidRootCount()).to.equal(1n);

    // After 29 deposits all 30 slots are filled
    await makeDeposits(mixer, depositor, 29);
    expect(await mixer.getValidRootCount()).to.equal(30n);

    // Further deposits overwrite existing slots — count stays at 30
    await makeDeposits(mixer, depositor, 10);
    expect(await mixer.getValidRootCount()).to.equal(30n);
  });

  it("evicted root is no longer known via isKnownRoot", async function () {
    const { mixer, depositor } = await loadFixture(deployMixerFixture);

    // The empty-tree root sits at slot 0 initially
    const emptyTreeRoot = await mixer.roots(0n);

    // 30 deposits: slot 0 is overwritten on the 30th deposit
    // (newRootIndex = (29+1) % 30 = 0)
    await makeDeposits(mixer, depositor, 30);

    // The empty-tree root is no longer in the ring buffer
    expect(await mixer.isKnownRoot(emptyTreeRoot)).to.equal(false);
  });
});
