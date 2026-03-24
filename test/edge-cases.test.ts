import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

const TREE_HEIGHT = 5;
const DENOMINATION = ethers.parseEther("0.1");

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

async function deployFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const hasherAddress = await deployHasher();
  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const Mixer = await ethers.getContractFactory("Mixer");
  const mixer = await Mixer.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    TREE_HEIGHT,
    hasherAddress
  );
  return { mixer, owner, alice, bob };
}

describe("Edge Cases", function () {
  it("contract receives exact denomination — no excess ETH stuck", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const commitment = ethers.toBigInt(ethers.randomBytes(31));
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION);
  });

  it("multiple rapid deposits don't corrupt the tree", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    for (let i = 0; i < 5; i++) {
      const c = ethers.toBigInt(ethers.randomBytes(31));
      await mixer.connect(alice).deposit(c, { value: DENOMINATION });
    }
    expect(await mixer.nextIndex()).to.equal(5n);
    expect(await mixer.getLastRoot()).to.not.equal(0n);
  });

  it("hashLeftRight is consistent with on-chain Poseidon", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const a = 123456789n;
    const b = 987654321n;
    const hash1 = await mixer.hashLeftRight(a, b);
    const hash2 = await mixer.hashLeftRight(a, b);
    expect(hash1).to.equal(hash2);
    expect(hash1).to.not.equal(0n);
  });

  it("deposit and withdraw don't affect other users' funds", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);
    const c1 = ethers.toBigInt(ethers.randomBytes(31));
    const c2 = ethers.toBigInt(ethers.randomBytes(31));

    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    await mixer.connect(bob).deposit(c2, { value: DENOMINATION });

    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION * 2n);

    const root = await mixer.getLastRoot();
    const nullifier = ethers.toBigInt(ethers.randomBytes(31));

    await mixer
      .connect(alice)
      .withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        bob.address,
        ethers.ZeroAddress,
        0n
      );

    expect(
      await ethers.provider.getBalance(await mixer.getAddress())
    ).to.equal(DENOMINATION);
  });

  it("getStats returns coherent values after deposit + withdrawal cycle", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);
    const c = ethers.toBigInt(ethers.randomBytes(31));
    await mixer.connect(alice).deposit(c, { value: DENOMINATION });

    const root = await mixer.getLastRoot();
    const nullifier = ethers.toBigInt(ethers.randomBytes(31));
    await mixer
      .connect(alice)
      .withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        bob.address,
        ethers.ZeroAddress,
        0n
      );

    const [totalDep, totalWith, depCount, withCount, balance] =
      await mixer.getStats();
    expect(totalDep).to.equal(DENOMINATION);
    expect(totalWith).to.equal(DENOMINATION);
    expect(depCount).to.equal(1n);
    expect(withCount).to.equal(1n);
    expect(balance).to.equal(0n);
  });

  it("tree root is distinct after each of 3 consecutive deposits", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const roots: bigint[] = [];

    for (let i = 0; i < 3; i++) {
      const c = ethers.toBigInt(ethers.randomBytes(31));
      await mixer.connect(alice).deposit(c, { value: DENOMINATION });
      roots.push(await mixer.getLastRoot());
    }

    // All three roots must be distinct
    expect(roots[0]).to.not.equal(roots[1]);
    expect(roots[1]).to.not.equal(roots[2]);
    expect(roots[0]).to.not.equal(roots[2]);
  });
});
