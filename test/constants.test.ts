import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";

// Mirror the library values here so the test can assert on-chain vs off-chain agreement
const MIXER_FIELD_SIZE =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MIXER_ROOT_HISTORY_SIZE = 30n;

async function deployMixerFixture() {
  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = await MixerFactory.deploy(
    await verifier.getAddress(),
    100_000_000_000_000_000n, // 0.1 ETH
    20,
    hasherAddress
  );

  return { mixer };
}

describe("MixerConstants", function () {
  it("FIELD_SIZE constant matches MerkleTree", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    expect(await mixer.FIELD_SIZE()).to.equal(MIXER_FIELD_SIZE);
  });

  it("ROOT_HISTORY_SIZE constant matches MerkleTree", async function () {
    const { mixer } = await loadFixture(deployMixerFixture);
    expect(await mixer.ROOT_HISTORY_SIZE()).to.equal(MIXER_ROOT_HISTORY_SIZE);
  });
});
