import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function deployMixerFixture() {
  const [owner, alice, bob] = await ethers.getSigners();
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
  return { mixer, owner, alice, bob };
}

async function doDeposit(mixer: Mixer, signer: Awaited<ReturnType<typeof ethers.getSigners>>[number]) {
  const c = randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return c;
}

describe("Mixer — per-address deposit limit", function () {
  describe("default state", function () {
    it("maxDepositsPerAddress defaults to 0 (unlimited)", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.maxDepositsPerAddress()).to.equal(0n);
    });

    it("getRemainingDeposits returns max uint256 when no limit set", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      expect(await mixer.getRemainingDeposits(alice.address)).to.equal(
        ethers.MaxUint256
      );
    });

    it("allows unlimited deposits by default", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      for (let i = 0; i < 5; i++) {
        await doDeposit(mixer, alice);
      }
      expect(await mixer.depositsPerAddress(alice.address)).to.equal(5n);
    });
  });

  describe("setMaxDepositsPerAddress", function () {
    it("only owner can set the limit", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(alice).setMaxDepositsPerAddress(3n)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("owner can set the limit and event is emitted", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(mixer.connect(owner).setMaxDepositsPerAddress(3n))
        .to.emit(mixer, "MaxDepositsPerAddressUpdated")
        .withArgs(3n);
      expect(await mixer.maxDepositsPerAddress()).to.equal(3n);
    });

    it("owner can reset limit to 0 (unlimited)", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(3n);
      await mixer.connect(owner).setMaxDepositsPerAddress(0n);
      expect(await mixer.maxDepositsPerAddress()).to.equal(0n);
    });
  });

  describe("enforcement", function () {
    it("allows exactly maxDepositsPerAddress deposits", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(3n);
      for (let i = 0; i < 3; i++) {
        await doDeposit(mixer, alice);
      }
      expect(await mixer.depositsPerAddress(alice.address)).to.equal(3n);
    });

    it("reverts on the 4th deposit when limit is 3", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(3n);
      for (let i = 0; i < 3; i++) {
        await doDeposit(mixer, alice);
      }
      const c = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(c, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: deposit limit reached");
    });

    it("limit is per-address: different addresses are independent", async function () {
      const { mixer, owner, alice, bob } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(2n);
      await doDeposit(mixer, alice);
      await doDeposit(mixer, alice);
      // alice is now at limit; bob should still be able to deposit
      await doDeposit(mixer, bob);
      expect(await mixer.depositsPerAddress(bob.address)).to.equal(1n);
    });

    it("removing the limit (set to 0) allows further deposits after hitting the old limit", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(2n);
      await doDeposit(mixer, alice);
      await doDeposit(mixer, alice);
      // hit limit, then remove it
      await mixer.connect(owner).setMaxDepositsPerAddress(0n);
      await doDeposit(mixer, alice); // should succeed
      expect(await mixer.depositsPerAddress(alice.address)).to.equal(3n);
    });
  });

  describe("getRemainingDeposits", function () {
    it("returns correct remaining count after some deposits", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(3n);
      await doDeposit(mixer, alice);
      expect(await mixer.getRemainingDeposits(alice.address)).to.equal(2n);
    });

    it("returns 0 when limit is fully consumed", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(3n);
      for (let i = 0; i < 3; i++) {
        await doDeposit(mixer, alice);
      }
      expect(await mixer.getRemainingDeposits(alice.address)).to.equal(0n);
    });

    it("returns max uint256 when limit is 0 (unlimited)", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).setMaxDepositsPerAddress(3n);
      await mixer.connect(owner).setMaxDepositsPerAddress(0n);
      expect(await mixer.getRemainingDeposits(alice.address)).to.equal(
        ethers.MaxUint256
      );
    });
  });
});
