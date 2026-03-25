import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer } from "../typechain-types";

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH
const COOLDOWN = 60; // 60 seconds

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

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

async function doDeposit(mixer: Mixer, signer: Signer) {
  const c = randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return c;
}

async function timelockSetCooldown(
  mixer: Mixer,
  owner: Signer,
  _cooldown: bigint
): Promise<void> {
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256"],
      ["setDepositCooldown", _cooldown]
    )
  );
  await mixer.connect(owner).queueAction(actionHash);
  await time.increase(24 * 60 * 60 + 1); // 1 day + 1 second
  await mixer.connect(owner).setDepositCooldown(_cooldown);
}

describe("Mixer — per-address deposit cooldown", function () {
  describe("default state", function () {
    it("depositCooldown defaults to 0 (no cooldown)", async function () {
      const { mixer } = await loadFixture(deployMixerFixture);
      expect(await mixer.depositCooldown()).to.equal(0n);
    });

    it("allows back-to-back deposits when cooldown is 0", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      await doDeposit(mixer, alice);
      await doDeposit(mixer, alice);
      expect(await mixer.depositsPerAddress(alice.address)).to.equal(2n);
    });
  });

  describe("setDepositCooldown", function () {
    it("only owner can queue the cooldown action", async function () {
      const { mixer, alice } = await loadFixture(deployMixerFixture);
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setDepositCooldown", BigInt(COOLDOWN)]
        )
      );
      await expect(
        mixer.connect(alice).queueAction(actionHash)
      ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
    });

    it("owner sets cooldown and event is emitted", async function () {
      const { mixer, owner } = await loadFixture(deployMixerFixture);
      const actionHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256"],
          ["setDepositCooldown", BigInt(COOLDOWN)]
        )
      );
      await mixer.connect(owner).queueAction(actionHash);
      await time.increase(24 * 60 * 60 + 1);
      await expect(mixer.connect(owner).setDepositCooldown(BigInt(COOLDOWN)))
        .to.emit(mixer, "DepositCooldownUpdated")
        .withArgs(BigInt(COOLDOWN));
      expect(await mixer.depositCooldown()).to.equal(BigInt(COOLDOWN));
    });
  });

  describe("enforcement", function () {
    it("reverts when depositing again before cooldown expires", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, BigInt(COOLDOWN));
      await doDeposit(mixer, alice);
      const c = randomCommitment();
      await expect(
        mixer.connect(alice).deposit(c, { value: DENOMINATION })
      ).to.be.revertedWith("Mixer: deposit cooldown active");
    });

    it("allows deposit after cooldown period has elapsed", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, BigInt(COOLDOWN));
      await doDeposit(mixer, alice);
      await time.increase(COOLDOWN + 1);
      await doDeposit(mixer, alice);
      expect(await mixer.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("cooldown is per-address: different addresses are independent", async function () {
      const { mixer, owner, alice, bob } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, BigInt(COOLDOWN));
      await doDeposit(mixer, alice);
      // alice is in cooldown, bob should deposit freely
      await doDeposit(mixer, bob);
      expect(await mixer.depositsPerAddress(bob.address)).to.equal(1n);
    });

    it("setting cooldown to 0 removes the restriction", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, BigInt(COOLDOWN));
      await doDeposit(mixer, alice);
      await timelockSetCooldown(mixer, owner, 0n);
      await doDeposit(mixer, alice); // should not revert
      expect(await mixer.depositsPerAddress(alice.address)).to.equal(2n);
    });

    it("lastDepositTime is updated after each deposit", async function () {
      const { mixer, owner, alice } = await loadFixture(deployMixerFixture);
      await timelockSetCooldown(mixer, owner, BigInt(COOLDOWN));
      await doDeposit(mixer, alice);
      const ts1 = await mixer.lastDepositTime(alice.address);
      await time.increase(COOLDOWN + 1);
      await doDeposit(mixer, alice);
      const ts2 = await mixer.lastDepositTime(alice.address);
      expect(ts2).to.be.greaterThan(ts1);
    });
  });
});
