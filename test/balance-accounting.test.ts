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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCommitment(): bigint {
  const raw = BigInt(
    "0x" + Buffer.from(ethers.randomBytes(31)).toString("hex")
  );
  return raw === 0n ? 1n : raw;
}

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();

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

  return { mixer, verifier, owner, alice, bob, relayer };
}

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

async function doDeposit(mixer: Mixer, signer: Signer, commitment?: bigint) {
  const c = commitment ?? randomCommitment();
  await mixer.connect(signer).deposit(c, { value: DENOMINATION });
  return c;
}

async function doWithdraw(
  mixer: Mixer,
  recipient: Signer,
  relayerAddr: string = ZERO_ADDRESS,
  fee: bigint = 0n
) {
  const root = await mixer.getLastRoot();
  const nullifier = randomCommitment();
  await mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifier,
    recipient.address as `0x${string}`,
    relayerAddr as `0x${string}`,
    fee
  );
}

// Reads provider balance AND getStats().poolBalance and asserts they match.
async function assertBalanceConsistency(mixer: Mixer): Promise<bigint> {
  const poolAddr = await mixer.getAddress();
  const providerBalance = await ethers.provider.getBalance(poolAddr);
  const [, , , , statsBalance] = await mixer.getStats();
  expect(statsBalance).to.equal(
    providerBalance,
    "getStats.poolBalance must match provider.getBalance"
  );
  return providerBalance;
}

// ---------------------------------------------------------------------------
// Balance Accounting Tests
// ---------------------------------------------------------------------------

describe("Balance Accounting", function () {
  it("initial balance is 0", async function () {
    const { mixer } = await loadFixture(deployFixture);

    const balance = await assertBalanceConsistency(mixer);
    expect(balance).to.equal(0n);
  });

  it("after 1 deposit: balance == denomination", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);

    await doDeposit(mixer, alice);

    const balance = await assertBalanceConsistency(mixer);
    expect(balance).to.equal(DENOMINATION);
  });

  it("after N deposits: balance == N * denomination", async function () {
    const { mixer, alice } = await loadFixture(deployFixture);
    const N = 4n;

    for (let i = 0; i < Number(N); i++) {
      await doDeposit(mixer, alice);
    }

    const balance = await assertBalanceConsistency(mixer);
    expect(balance).to.equal(N * DENOMINATION);
  });

  it("after deposit + withdrawal: balance == 0", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    await doDeposit(mixer, alice);
    await doWithdraw(mixer, bob);

    const balance = await assertBalanceConsistency(mixer);
    expect(balance).to.equal(0n);
  });

  it("after 5 deposits + 2 withdrawals: balance == 3 * denomination", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    for (let i = 0; i < 5; i++) {
      await doDeposit(mixer, alice);
    }
    for (let i = 0; i < 2; i++) {
      await doWithdraw(mixer, bob);
    }

    const balance = await assertBalanceConsistency(mixer);
    expect(balance).to.equal(3n * DENOMINATION);
  });

  it("balance == getStats.poolBalance at all times", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    await assertBalanceConsistency(mixer);

    for (let i = 0; i < 3; i++) {
      await doDeposit(mixer, alice);
      await assertBalanceConsistency(mixer);
    }

    for (let i = 0; i < 2; i++) {
      await doWithdraw(mixer, bob);
      await assertBalanceConsistency(mixer);
    }
  });

  it("balance == totalDeposited - totalWithdrawn at all times", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const assertAccounting = async () => {
      const [totalDeposited, totalWithdrawn, , , poolBalance] =
        await mixer.getStats();
      expect(poolBalance).to.equal(
        totalDeposited - totalWithdrawn,
        "balance must equal totalDeposited - totalWithdrawn"
      );
    };

    await assertAccounting();

    for (let i = 0; i < 4; i++) {
      await doDeposit(mixer, alice);
      await assertAccounting();
    }

    for (let i = 0; i < 3; i++) {
      await doWithdraw(mixer, bob);
      await assertAccounting();
    }
  });

  it("withdrawal with fee: balance decreases by full denomination", async function () {
    const { mixer, alice, bob, relayer } = await loadFixture(deployFixture);

    await doDeposit(mixer, alice);
    const balanceBefore = await assertBalanceConsistency(mixer);

    const fee = ethers.parseEther("0.01"); // 0.01 ETH fee
    await doWithdraw(mixer, bob, await relayer.getAddress(), fee);

    const balanceAfter = await assertBalanceConsistency(mixer);
    // The full denomination leaves the pool (fee + recipient share together == denomination)
    expect(balanceBefore - balanceAfter).to.equal(DENOMINATION);
    expect(balanceAfter).to.equal(0n);
  });

  it("balance never goes below 0 (withdrawal fails if insufficient)", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    // Pool is empty — withdrawal must revert
    const root = await mixer.getLastRoot();
    const nullifier = randomCommitment();

    await expect(
      mixer.withdraw(
        DUMMY_PA,
        DUMMY_PB,
        DUMMY_PC,
        root,
        nullifier,
        bob.address as `0x${string}`,
        ZERO_ADDRESS as `0x${string}`,
        0n
      )
    ).to.be.reverted;

    // After the failed attempt, balance must still be 0
    const balance = await assertBalanceConsistency(mixer);
    expect(balance).to.equal(0n);

    // Confirm that a single deposit + withdrawal still ends at 0 (sanity)
    await doDeposit(mixer, alice);
    await doWithdraw(mixer, bob);
    const finalBalance = await assertBalanceConsistency(mixer);
    expect(finalBalance).to.equal(0n);
  });

  it("getPoolHealth.poolBalance matches provider balance", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    const checkHealth = async () => {
      const poolAddr = await mixer.getAddress();
      const providerBalance = await ethers.provider.getBalance(poolAddr);
      const [, , healthBalance] = await mixer.getPoolHealth();
      expect(healthBalance).to.equal(
        providerBalance,
        "getPoolHealth.poolBalance must match provider.getBalance"
      );
    };

    await checkHealth();

    for (let i = 0; i < 3; i++) {
      await doDeposit(mixer, alice);
      await checkHealth();
    }

    await doWithdraw(mixer, bob);
    await checkHealth();
  });

  it("10 deposits + 10 withdrawals: final balance == 0", async function () {
    const { mixer, alice, bob } = await loadFixture(deployFixture);

    for (let i = 0; i < 10; i++) {
      await doDeposit(mixer, alice);
    }

    const [, , , , balanceMid] = await mixer.getStats();
    expect(balanceMid).to.equal(10n * DENOMINATION);

    for (let i = 0; i < 10; i++) {
      await doWithdraw(mixer, bob);
    }

    const balance = await assertBalanceConsistency(mixer);
    expect(balance).to.equal(0n);

    const [totalDeposited, totalWithdrawn] = await mixer.getStats();
    expect(totalDeposited).to.equal(totalWithdrawn);
    expect(totalDeposited).to.equal(10n * DENOMINATION);
  });
});
