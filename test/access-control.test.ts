import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;

async function deployFixture() {
  const [owner, alice] = await ethers.getSigners();
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
  return { mixer, owner, alice };
}

/** Compute a timelocked action hash (single uint256 param). */
function makeActionHash(name: string, value: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [name, value])
  );
}

/** Queue and wait for a timelock to expire. */
async function queueAndWait(mixer: Mixer, hash: string): Promise<void> {
  await mixer.queueAction(hash);
  await time.increase(ONE_DAY + 1);
}

// ---------------------------------------------------------------------------
// Access Control Matrix
// ---------------------------------------------------------------------------

describe("Access Control Matrix", function () {
  // Every owner-only function paired with a non-owner call that must revert.
  const ownerOnlyFunctions: Array<{
    name: string;
    call: (mixer: Mixer, stranger: Awaited<ReturnType<typeof ethers.getSigner>>) => Promise<unknown>;
  }> = [
    {
      name: "pause",
      call: (mixer, stranger) => mixer.connect(stranger).pause(),
    },
    {
      name: "unpause",
      call: async (mixer, stranger) => {
        // owner pauses first so unpause is callable
        await mixer.pause();
        return mixer.connect(stranger).unpause();
      },
    },
    {
      name: "queueAction",
      call: (mixer, stranger) =>
        mixer.connect(stranger).queueAction(ethers.ZeroHash),
    },
    {
      name: "cancelAction",
      call: async (mixer, stranger) => {
        // queue a non-zero hash as owner so cancelAction sees a valid pending action
        const nonZeroHash = ethers.keccak256(ethers.toUtf8Bytes("test-action"));
        await mixer.queueAction(nonZeroHash);
        return mixer.connect(stranger).cancelAction();
      },
    },
    {
      name: "setMaxDepositsPerAddress",
      call: (mixer, stranger) =>
        mixer
          .connect(stranger)
          .setMaxDepositsPerAddress(5n),
    },
    {
      name: "setDepositReceipt",
      call: (mixer, stranger) =>
        mixer
          .connect(stranger)
          .setDepositReceipt(ethers.ZeroAddress),
    },
  ];

  for (const fn of ownerOnlyFunctions) {
    it(`${fn.name} reverts with OwnableUnauthorizedAccount for non-owner`, async function () {
      const { mixer, alice } = await loadFixture(deployFixture);
      await expect(fn.call(mixer, alice)).to.be.revertedWithCustomError(
        mixer,
        "OwnableUnauthorizedAccount"
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Positive: owner can call every immediate admin function without revert
  // ---------------------------------------------------------------------------

  it("owner can call pause and unpause", async function () {
    const { mixer } = await loadFixture(deployFixture);
    await expect(mixer.pause()).to.not.be.reverted;
    await expect(mixer.unpause()).to.not.be.reverted;
  });

  it("owner can queueAction and cancelAction", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const nonZeroHash = makeActionHash("setMaxDepositsPerAddress", 1n);
    await expect(mixer.queueAction(nonZeroHash)).to.not.be.reverted;
    await expect(mixer.cancelAction()).to.not.be.reverted;
  });

  it("owner can execute setMaxDepositsPerAddress after timelock", async function () {
    const { mixer } = await loadFixture(deployFixture);
    const hash = makeActionHash("setMaxDepositsPerAddress", 10n);
    await queueAndWait(mixer, hash);
    await expect(mixer.setMaxDepositsPerAddress(10n)).to.not.be.reverted;
  });

  it("owner can execute setDepositReceipt after timelock", async function () {
    const { mixer } = await loadFixture(deployFixture);
    // Hash encoding matches contract: keccak256(abi.encode("setDepositReceipt", _receipt))
    const encodedHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "address"],
        ["setDepositReceipt", ethers.ZeroAddress]
      )
    );
    await queueAndWait(mixer, encodedHash);
    await expect(mixer.setDepositReceipt(ethers.ZeroAddress)).to.not.be.reverted;
  });
});
