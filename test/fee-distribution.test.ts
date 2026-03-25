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

async function deployMixerFixture() {
  const [owner, depositor, recipient, relayer] = await ethers.getSigners();

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

  return { mixer, owner, depositor, recipient, relayer };
}

async function depositAndGetRoot(
  mixer: Mixer,
  depositor: Signer
): Promise<{ root: bigint; nullifierHash: bigint }> {
  const commitment = randomCommitment();
  await mixer.connect(depositor).deposit(commitment, { value: DENOMINATION });
  const root = await mixer.getLastRoot();
  const nullifierHash = randomCommitment();
  return { root, nullifierHash };
}

function doWithdraw(
  mixer: Mixer,
  root: bigint,
  nullifierHash: bigint,
  recipient: string,
  relayer: string,
  fee: bigint
) {
  return mixer.withdraw(
    DUMMY_PA,
    DUMMY_PB,
    DUMMY_PC,
    root,
    nullifierHash,
    recipient as `0x${string}`,
    relayer as `0x${string}`,
    fee
  );
}

// ---------------------------------------------------------------------------
// Fee Distribution Tests
// ---------------------------------------------------------------------------

describe("Fee Distribution", function () {
  it("zero fee: full denomination goes to recipient", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);

    const recipientBefore = await ethers.provider.getBalance(recipient.address);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      relayer.address,
      0n
    );

    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION);
  });

  it("small fee: recipient gets denomination - fee, relayer gets fee", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);
    const fee = 1_000_000_000_000_000n; // 0.001 ETH

    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      relayer.address,
      fee
    );

    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    const relayerAfter = await ethers.provider.getBalance(relayer.address);

    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION - fee);
    expect(relayerAfter - relayerBefore).to.equal(fee);
  });

  it("fee == denomination: relayer gets everything, recipient gets zero", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);

    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      relayer.address,
      DENOMINATION
    );

    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    const relayerAfter = await ethers.provider.getBalance(relayer.address);

    expect(recipientAfter - recipientBefore).to.equal(0n);
    expect(relayerAfter - relayerBefore).to.equal(DENOMINATION);
  });

  it("fee > denomination: reverts", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);
    const fee = DENOMINATION + 1n;

    await expect(
      doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipient.address,
        relayer.address,
        fee
      )
    ).to.be.revertedWith("Mixer: fee exceeds denomination");
  });

  it("non-zero fee with zero relayer: reverts", async function () {
    const { mixer, depositor, recipient } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);
    const fee = 1_000_000_000_000_000n;

    await expect(
      doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipient.address,
        ZERO_ADDRESS,
        fee
      )
    ).to.be.revertedWith("Mixer: relayer is zero address for non-zero fee");
  });

  it("zero fee with zero relayer: succeeds (no relayer needed)", async function () {
    const { mixer, depositor, recipient } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);

    await expect(
      doWithdraw(
        mixer,
        root,
        nullifierHash,
        recipient.address,
        ZERO_ADDRESS,
        0n
      )
    ).to.not.be.reverted;
  });

  it("fee doesn't affect pool balance accounting (pool balance drops by full denomination)", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);
    const fee = 5_000_000_000_000_000n; // 0.005 ETH

    const poolAddress = await mixer.getAddress();
    const poolBefore = await ethers.provider.getBalance(poolAddress);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      relayer.address,
      fee
    );

    const poolAfter = await ethers.provider.getBalance(poolAddress);
    // Pool loses the entire denomination regardless of fee split
    expect(poolBefore - poolAfter).to.equal(DENOMINATION);
  });

  it("relayer balance increases by exact fee amount", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);
    const fee = 10_000_000_000_000_000n; // 0.01 ETH

    const relayerBefore = await ethers.provider.getBalance(relayer.address);

    // Withdraw from a different signer so relayer's gas costs don't muddy the delta
    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      relayer.address,
      fee
    );

    const relayerAfter = await ethers.provider.getBalance(relayer.address);
    expect(relayerAfter - relayerBefore).to.equal(fee);
  });

  it("recipient balance increases by exact (denomination - fee) amount", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);
    const fee = 20_000_000_000_000_000n; // 0.02 ETH

    const recipientBefore = await ethers.provider.getBalance(recipient.address);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      relayer.address,
      fee
    );

    const recipientAfter = await ethers.provider.getBalance(recipient.address);
    expect(recipientAfter - recipientBefore).to.equal(DENOMINATION - fee);
  });

  it("totalWithdrawn reflects full denomination regardless of fee split", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    const { root, nullifierHash } = await depositAndGetRoot(mixer, depositor);
    const fee = 50_000_000_000_000_000n; // 0.05 ETH — half the denomination

    expect(await mixer.totalWithdrawn()).to.equal(0n);

    await doWithdraw(
      mixer,
      root,
      nullifierHash,
      recipient.address,
      relayer.address,
      fee
    );

    // totalWithdrawn must be the full denomination, not denomination - fee
    expect(await mixer.totalWithdrawn()).to.equal(DENOMINATION);
  });

  it("consecutive withdrawals accumulate totalWithdrawn by denomination each time", async function () {
    const { mixer, depositor, recipient, relayer } =
      await loadFixture(deployMixerFixture);

    // First withdrawal — small fee
    const commitment1 = randomCommitment();
    await mixer.connect(depositor).deposit(commitment1, { value: DENOMINATION });
    const root1 = await mixer.getLastRoot();
    const nullifier1 = randomCommitment();
    await doWithdraw(mixer, root1, nullifier1, recipient.address, relayer.address, 1_000_000_000_000_000n);

    // Second withdrawal — full fee
    const commitment2 = randomCommitment();
    await mixer.connect(depositor).deposit(commitment2, { value: DENOMINATION });
    const root2 = await mixer.getLastRoot();
    const nullifier2 = randomCommitment();
    await doWithdraw(mixer, root2, nullifier2, recipient.address, relayer.address, DENOMINATION);

    expect(await mixer.totalWithdrawn()).to.equal(DENOMINATION * 2n);
  });
});
