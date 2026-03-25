import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ROOT_HISTORY_SIZE = 30n;

const ZERO_PROOF = {
  pA: [0n, 0n] as [bigint, bigint],
  pB: [
    [0n, 0n],
    [0n, 0n],
  ] as [[bigint, bigint], [bigint, bigint]],
  pC: [0n, 0n] as [bigint, bigint],
};

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const verifierAddress = await verifier.getAddress();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    verifierAddress,
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, verifierAddress, hasherAddress, owner, depositor, recipient, relayer };
}

// ---------------------------------------------------------------------------
// Storage Verification
// ---------------------------------------------------------------------------

describe("Storage Verification", function () {
  it("denomination is stored correctly and immutable", async () => {
    const { mixer } = await loadFixture(deployFixture);

    expect(await mixer.denomination()).to.equal(DENOMINATION);
  });

  it("levels is stored correctly and immutable", async () => {
    const { mixer } = await loadFixture(deployFixture);

    expect(await mixer.levels()).to.equal(MERKLE_TREE_HEIGHT);
  });

  it("verifier address is stored correctly and immutable", async () => {
    const { mixer, verifierAddress } = await loadFixture(deployFixture);

    expect(await mixer.verifier()).to.equal(verifierAddress);
  });

  it("hasher address is stored correctly and immutable", async () => {
    const { mixer, hasherAddress } = await loadFixture(deployFixture);

    expect(await mixer.hasher()).to.equal(hasherAddress);
  });

  it("deployedChainId is stored correctly and immutable", async () => {
    const { mixer } = await loadFixture(deployFixture);

    const { chainId } = await ethers.provider.getNetwork();
    expect(await mixer.deployedChainId()).to.equal(chainId);
  });

  it("nextIndex starts at 0 and increments with deposits", async () => {
    const { mixer, depositor } = await loadFixture(deployFixture);

    expect(await mixer.nextIndex()).to.equal(0n);

    const commitment1 = randomCommitment();
    await mixer.connect(depositor).deposit(commitment1, { value: DENOMINATION });
    expect(await mixer.nextIndex()).to.equal(1n);

    const commitment2 = randomCommitment();
    await mixer.connect(depositor).deposit(commitment2, { value: DENOMINATION });
    expect(await mixer.nextIndex()).to.equal(2n);
  });

  it("currentRootIndex wraps around ROOT_HISTORY_SIZE", async () => {
    const { mixer, depositor } = await loadFixture(deployFixture);

    // After deployment, currentRootIndex is 0 (initial root written at index 0)
    expect(await mixer.currentRootIndex()).to.equal(0n);

    // Each deposit increments currentRootIndex by 1, wrapping at ROOT_HISTORY_SIZE
    // Deposit ROOT_HISTORY_SIZE times to drive the index back to 0
    for (let i = 0; i < Number(ROOT_HISTORY_SIZE); i++) {
      const commitment = randomCommitment();
      await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
    }

    // After ROOT_HISTORY_SIZE deposits: index went 1,2,...,29,0
    expect(await mixer.currentRootIndex()).to.equal(0n);
  });

  it("commitments mapping stores boolean flags correctly", async () => {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitment = randomCommitment();

    // Before deposit — mapping returns false
    expect(await mixer.commitments(commitment)).to.equal(false);

    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    // After deposit — mapping returns true
    expect(await mixer.commitments(commitment)).to.equal(true);
  });

  it("nullifierHashes mapping stores boolean flags correctly", async () => {
    const { mixer, depositor, recipient, relayer } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    const nullifierHash = randomCommitment();

    // Before withdrawal — not spent
    expect(await mixer.nullifierHashes(nullifierHash)).to.equal(false);

    const root = await mixer.getLastRoot();
    const recipientAddr = await recipient.getAddress() as `0x${string}`;
    const relayerAddr = await relayer.getAddress() as `0x${string}`;

    await mixer.withdraw(
      ZERO_PROOF.pA,
      ZERO_PROOF.pB,
      ZERO_PROOF.pC,
      root,
      nullifierHash,
      recipientAddr,
      relayerAddr,
      0n
    );

    // After withdrawal — marked as spent
    expect(await mixer.nullifierHashes(nullifierHash)).to.equal(true);
  });

  it("depositsPerAddress mapping increments per deposit", async () => {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const depositorAddr = await depositor.getAddress();

    expect(await mixer.depositsPerAddress(depositorAddr)).to.equal(0n);

    const commitment1 = randomCommitment();
    await mixer.connect(depositor).deposit(commitment1, { value: DENOMINATION });
    expect(await mixer.depositsPerAddress(depositorAddr)).to.equal(1n);

    const commitment2 = randomCommitment();
    await mixer.connect(depositor).deposit(commitment2, { value: DENOMINATION });
    expect(await mixer.depositsPerAddress(depositorAddr)).to.equal(2n);
  });

  it("commitmentIndex mapping stores the leaf index for each commitment", async () => {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitment0 = randomCommitment();
    const commitment1 = randomCommitment();

    await mixer.connect(depositor).deposit(commitment0, { value: DENOMINATION });
    await mixer.connect(depositor).deposit(commitment1, { value: DENOMINATION });

    expect(await mixer.commitmentIndex(commitment0)).to.equal(0n);
    expect(await mixer.commitmentIndex(commitment1)).to.equal(1n);
  });

  it("indexToCommitment mapping is the reverse lookup of commitmentIndex", async () => {
    const { mixer, depositor } = await loadFixture(deployFixture);

    const commitment = randomCommitment();
    await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });

    expect(await mixer.indexToCommitment(0n)).to.equal(commitment);
  });
});
