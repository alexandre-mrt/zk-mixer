import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployHasher } from "./helpers/hasher";
import type { Mixer, Groth16Verifier } from "../typechain-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERKLE_TREE_HEIGHT = 5;
const DENOMINATION = 100_000_000_000_000_000n; // 0.1 ETH in wei

const DUMMY_PA: [bigint, bigint] = [0n, 0n];
const DUMMY_PB: [[bigint, bigint], [bigint, bigint]] = [
  [0n, 0n],
  [0n, 0n],
];
const DUMMY_PC: [bigint, bigint] = [0n, 0n];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

async function deployMixerFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  const hasherAddress = await deployHasher();

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = (await Verifier.deploy()) as unknown as Groth16Verifier;

  const MixerFactory = await ethers.getContractFactory("Mixer");
  const mixer = (await MixerFactory.deploy(
    await verifier.getAddress(),
    DENOMINATION,
    MERKLE_TREE_HEIGHT,
    hasherAddress
  )) as unknown as Mixer;

  return { mixer, verifier, owner, alice, bob, carol };
}

// ---------------------------------------------------------------------------
// Emergency Scenarios — incident response workflows
// ---------------------------------------------------------------------------

describe("Emergency Scenarios", function () {
  // -------------------------------------------------------------------------
  // Exploit detected: pause halts all state-mutating operations
  // -------------------------------------------------------------------------

  it("exploit detected: pause immediately stops deposits", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    await mixer.connect(owner).pause();

    const commitment = randomCommitment();
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
  });

  it("exploit detected: pause immediately stops withdrawals", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    // Deposit before pause to have a valid root
    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();

    await mixer.connect(owner).pause();

    await expect(
      mixer.connect(alice).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        alice.address,
        alice.address,
        0n
      )
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");
  });

  it("pause doesn't affect read-only operations (getStats, getPoolHealth, getLastRoot)", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    await mixer.connect(alice).deposit(randomCommitment(), { value: DENOMINATION });
    const rootBefore = await mixer.getLastRoot();
    const statsBefore = await mixer.getStats();

    await mixer.connect(owner).pause();

    // All view functions must still return data without reverting
    const rootAfter = await mixer.getLastRoot();
    const statsAfter = await mixer.getStats();
    const health = await mixer.getPoolHealth();
    const depositCount = await mixer.getDepositCount();
    const version = await mixer.getVersion();

    expect(rootAfter).to.equal(rootBefore);
    expect(statsAfter[2]).to.equal(statsBefore[2]); // depositCount unchanged
    expect(health[3]).to.be.true; // isPaused = true
    expect(depositCount).to.equal(1n);
    expect(version).to.equal("1.0.0");
  });

  it("false alarm: unpause resumes all operations", async function () {
    const { mixer, owner, alice, bob } = await loadFixture(deployMixerFixture);

    // Pause then immediately unpause (false alarm)
    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();

    expect(await mixer.paused()).to.be.false;

    // Deposit must succeed after unpause
    const commitment = randomCommitment();
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.not.be.reverted;

    // Withdraw must succeed after unpause (proof fails due to dummy proof — that's expected)
    const root = await mixer.getLastRoot();
    const nullifierHash = randomCommitment();
    await expect(
      mixer.connect(bob).withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifierHash,
        bob.address,
        bob.address,
        0n
      )
    ).to.not.be.revertedWithCustomError(mixer, "EnforcedPause");
  });

  it("ownership transfer under emergency: new owner can unpause", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    await mixer.connect(owner).pause();
    expect(await mixer.paused()).to.be.true;

    // Transfer ownership to alice
    await mixer.connect(owner).transferOwnership(alice.address);
    expect(await mixer.owner()).to.equal(alice.address);

    // New owner (alice) must be able to unpause
    await mixer.connect(alice).unpause();
    expect(await mixer.paused()).to.be.false;

    // Old owner must no longer be able to pause
    await expect(
      mixer.connect(owner).pause()
    ).to.be.revertedWithCustomError(mixer, "OwnableUnauthorizedAccount");
  });

  it("rapid pause/unpause cycles don't corrupt state", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    // Make an initial deposit to establish state
    const commitment1 = randomCommitment();
    await mixer.connect(alice).deposit(commitment1, { value: DENOMINATION });
    const depositCountBefore = await mixer.getDepositCount();
    const totalDepositedBefore = (await mixer.getStats())[0];

    // Multiple rapid pause/unpause cycles
    for (let i = 0; i < 5; i++) {
      await mixer.connect(owner).pause();
      await mixer.connect(owner).unpause();
    }

    // State must be identical after all cycles
    expect(await mixer.paused()).to.be.false;
    expect(await mixer.getDepositCount()).to.equal(depositCountBefore);
    expect((await mixer.getStats())[0]).to.equal(totalDepositedBefore);

    // New deposit must still work and increment correctly
    const commitment2 = randomCommitment();
    await mixer.connect(alice).deposit(commitment2, { value: DENOMINATION });
    expect(await mixer.getDepositCount()).to.equal(depositCountBefore + 1n);
  });

  it("deposit in-flight during pause: reverts on execution", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    // Simulate: owner pauses before alice's pending tx lands
    await mixer.connect(owner).pause();

    const commitment = randomCommitment();
    // The in-flight deposit arrives while contract is paused — must revert
    await expect(
      mixer.connect(alice).deposit(commitment, { value: DENOMINATION })
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");

    // Confirm the commitment was NOT inserted
    expect(await mixer.isCommitted(commitment)).to.be.false;
    expect(await mixer.getDepositCount()).to.equal(0n);
  });

  it("funds are safe during pause (balance unchanged)", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    // Deposit funds before pause
    const commitment = randomCommitment();
    await mixer.connect(alice).deposit(commitment, { value: DENOMINATION });

    const balanceBefore = await ethers.provider.getBalance(
      await mixer.getAddress()
    );
    expect(balanceBefore).to.equal(DENOMINATION);

    // Pause
    await mixer.connect(owner).pause();

    // Balance must remain exactly the same during pause
    const balanceDuringPause = await ethers.provider.getBalance(
      await mixer.getAddress()
    );
    expect(balanceDuringPause).to.equal(DENOMINATION);

    // A failed deposit attempt must not alter the balance
    const anotherCommitment = randomCommitment();
    await expect(
      mixer.connect(alice).deposit(anotherCommitment, { value: DENOMINATION })
    ).to.be.revertedWithCustomError(mixer, "EnforcedPause");

    const balanceAfterFailedDeposit = await ethers.provider.getBalance(
      await mixer.getAddress()
    );
    expect(balanceAfterFailedDeposit).to.equal(DENOMINATION);
  });

  it("after unpause: all historical roots still valid", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    // Insert several commitments to create a root history
    const c1 = randomCommitment();
    const c2 = randomCommitment();
    const c3 = randomCommitment();

    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });
    const root1 = await mixer.getLastRoot();

    await mixer.connect(alice).deposit(c2, { value: DENOMINATION });
    const root2 = await mixer.getLastRoot();

    // Pause and unpause
    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();

    await mixer.connect(alice).deposit(c3, { value: DENOMINATION });
    const root3 = await mixer.getLastRoot();

    // All roots from before the pause/unpause cycle must still be known
    expect(await mixer.isKnownRoot(root1)).to.be.true;
    expect(await mixer.isKnownRoot(root2)).to.be.true;
    expect(await mixer.isKnownRoot(root3)).to.be.true;
  });

  it("after unpause: new deposits get correct leaf indices", async function () {
    const { mixer, owner, alice } = await loadFixture(deployMixerFixture);

    const c1 = randomCommitment();
    await mixer.connect(alice).deposit(c1, { value: DENOMINATION });

    // Pause / unpause cycle
    await mixer.connect(owner).pause();
    await mixer.connect(owner).unpause();

    const c2 = randomCommitment();
    const tx = await mixer
      .connect(alice)
      .deposit(c2, { value: DENOMINATION });
    const receipt = await tx.wait();

    // Find the Deposit event to verify the leaf index is sequential
    const depositEvent = receipt?.logs
      .map((log) => {
        try {
          return mixer.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "Deposit");

    expect(depositEvent).to.not.be.undefined;
    // Index 0 was taken by c1, so c2 must land at index 1
    expect(depositEvent?.args.leafIndex).to.equal(1n);

    // commitmentIndex mapping must also reflect the correct index
    expect(await mixer.commitmentIndex(c2)).to.equal(1n);
  });
});
