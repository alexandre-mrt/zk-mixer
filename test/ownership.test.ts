import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;

async function deployMixerFixture() {
  const [owner, newOwner, stranger] = await ethers.getSigners();
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
  return { mixer, owner, newOwner, stranger };
}

// Queue + wait the timelock so a timelocked action can be executed.
async function queueAndWait(mixer: Mixer, actionHash: string) {
  await mixer.queueAction(actionHash);
  await time.increase(ONE_DAY + 1);
}

describe("Ownership", function () {
  it("deployer is initial owner", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    expect(await mixer.owner()).to.equal(await owner.getAddress());
  });

  it("owner can transfer ownership", async function () {
    const { mixer, owner, newOwner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).transferOwnership(await newOwner.getAddress());
    expect(await mixer.owner()).to.equal(await newOwner.getAddress());
  });

  it("new owner can call owner-only functions", async function () {
    const { mixer, owner, newOwner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).transferOwnership(await newOwner.getAddress());

    // pause() is an owner-only function with no timelock — use it as the probe
    await expect(mixer.connect(newOwner).pause()).to.not.be.reverted;
  });

  it("old owner cannot call owner-only functions after transfer", async function () {
    const { mixer, owner, newOwner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).transferOwnership(await newOwner.getAddress());

    await expect(
      mixer.connect(owner).pause()
    ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
  });

  it("non-owner cannot transfer ownership", async function () {
    const { mixer, stranger } = await loadFixture(deployMixerFixture);
    await expect(
      mixer.connect(stranger).transferOwnership(await stranger.getAddress())
    ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
  });

  it("owner can renounce ownership", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).renounceOwnership();
    expect(await mixer.owner()).to.equal(ethers.ZeroAddress);
  });

  it("after renounce, no one is owner", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).renounceOwnership();
    expect(await mixer.owner()).to.equal(ethers.ZeroAddress);
  });

  it("after renounce, owner-only functions revert", async function () {
    const { mixer, owner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).renounceOwnership();

    await expect(
      mixer.connect(owner).pause()
    ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
  });

  it("timelocked owner-only function works after ownership transfer + queue", async function () {
    const { mixer, owner, newOwner } = await loadFixture(deployMixerFixture);
    await mixer.connect(owner).transferOwnership(await newOwner.getAddress());

    const actionHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256"],
        ["setMaxDepositsPerAddress", 5n]
      )
    );
    await queueAndWait(mixer.connect(newOwner) as unknown as Mixer, actionHash);
    await expect(
      mixer.connect(newOwner).setMaxDepositsPerAddress(5n)
    ).to.not.be.reverted;
  });
});
