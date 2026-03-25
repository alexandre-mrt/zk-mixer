import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const ONE_DAY = 24 * 60 * 60;

function randomCommitment(): bigint {
  const raw = BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));
  return raw === 0n ? 1n : raw;
}

async function deployMixerFixture() {
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

function maxDepositsHash(_max: bigint): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setMaxDepositsPerAddress", _max]
    )
  );
}

describe("Mixer — timelock", function () {
  // ---------------------------------------------------------------------------
  // queueAction
  // ---------------------------------------------------------------------------

  describe("queueAction", function () {
    it("only owner can queue an action", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      await expect(
        mixer.connect(alice).queueAction(hash)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("emits ActionQueued with correct hash and executeAfter", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      const latestBlock = await ethers.provider.getBlock("latest");
      const expectedAfter = BigInt(latestBlock!.timestamp) + 1n + BigInt(ONE_DAY);

      await expect(mixer.connect(owner).queueAction(hash))
        .to.emit(mixer, "ActionQueued")
        .withArgs(hash, expectedAfter);
    });

    it("stores the pending action correctly", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      await mixer.connect(owner).queueAction(hash);

      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash);
      expect(pending.executeAfter).to.be.greaterThan(0n);
    });

    it("queueing a second action replaces the first", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash1 = maxDepositsHash(3n);
      const hash2 = maxDepositsHash(7n);
      await mixer.connect(owner).queueAction(hash1);
      await mixer.connect(owner).queueAction(hash2);

      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(hash2);
    });
  });

  // ---------------------------------------------------------------------------
  // cancelAction
  // ---------------------------------------------------------------------------

  describe("cancelAction", function () {
    it("only owner can cancel an action", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).queueAction(maxDepositsHash(5n));
      await expect(
        mixer.connect(alice).cancelAction()
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("reverts when no action is pending", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(owner).cancelAction()
      ).to.be.revertedWith("Mixer: no pending action");
    });

    it("emits ActionCancelled and clears pending action", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      await mixer.connect(owner).queueAction(hash);

      await expect(mixer.connect(owner).cancelAction())
        .to.emit(mixer, "ActionCancelled")
        .withArgs(hash);

      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
    });
  });

  // ---------------------------------------------------------------------------
  // setMaxDepositsPerAddress with timelock
  // ---------------------------------------------------------------------------

  describe("setMaxDepositsPerAddress — timelock enforcement", function () {
    it("executes after delay elapses", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      await mixer.connect(owner).queueAction(hash);
      await time.increase(ONE_DAY + 1);

      await expect(mixer.connect(owner).setMaxDepositsPerAddress(5n))
        .to.emit(mixer, "MaxDepositsPerAddressUpdated")
        .withArgs(5n);
      expect(await mixer.maxDepositsPerAddress()).to.equal(5n);
    });

    it("clears pending action after execution and emits ActionExecuted", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      await mixer.connect(owner).queueAction(hash);
      await time.increase(ONE_DAY + 1);

      await expect(mixer.connect(owner).setMaxDepositsPerAddress(5n))
        .to.emit(mixer, "ActionExecuted")
        .withArgs(hash);

      const pending = await mixer.pendingAction();
      expect(pending.actionHash).to.equal(ethers.ZeroHash);
    });

    it("reverts when called before delay elapses", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      await mixer.connect(owner).queueAction(hash);
      await time.increase(ONE_DAY - 60); // 1 minute short

      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(5n)
      ).to.be.revertedWith("Mixer: timelock not expired");
    });

    it("reverts when called with a different value than queued", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).queueAction(maxDepositsHash(5n));
      await time.increase(ONE_DAY + 1);

      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(10n) // wrong value
      ).to.be.revertedWith("Mixer: action not queued");
    });

    it("reverts when no action is queued", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(5n)
      ).to.be.revertedWith("Mixer: action not queued");
    });

    it("reverts after action is cancelled", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const hash = maxDepositsHash(5n);
      await mixer.connect(owner).queueAction(hash);
      await mixer.connect(owner).cancelAction();
      await time.increase(ONE_DAY + 1);

      await expect(
        mixer.connect(owner).setMaxDepositsPerAddress(5n)
      ).to.be.revertedWith("Mixer: action not queued");
    });
  });

  // ---------------------------------------------------------------------------
  // pause() — no timelock (emergency action)
  // ---------------------------------------------------------------------------

  describe("pause — no timelock required", function () {
    it("owner can pause immediately without queuing", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      await expect(mixer.connect(owner).pause()).to.not.be.reverted;
      const [, , , isPaused] = await mixer.getPoolHealth();
      expect(isPaused).to.equal(true);
    });

    it("deposit is blocked when paused (no timelock queued)", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await mixer.connect(owner).pause();
      await expect(
        mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION })
      ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
    });
  });
});
