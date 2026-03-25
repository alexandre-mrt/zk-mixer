import { task } from "hardhat/config";
import fs from "fs";

const DEPLOYMENT_FILE = "deployment.json";

task("info", "Display deployed contract information and pool status").setAction(
  async (_, hre) => {
    if (!fs.existsSync(DEPLOYMENT_FILE)) {
      console.log("No deployment.json found. Run deploy first.");
      return;
    }

    const addresses = JSON.parse(
      fs.readFileSync(DEPLOYMENT_FILE, "utf-8")
    ) as {
      mixer: string;
      verifier: string;
      depositReceipt?: string;
      network?: string;
      chainId?: number;
      denomination?: string;
      merkleTreeHeight?: number;
    };

    if (!addresses.mixer) {
      console.log("deployment.json is missing 'mixer' address.");
      return;
    }

    const mixer = await hre.ethers.getContractAt("Mixer", addresses.mixer);

    const [totalDep, totalWith, depCount, withCount, balance] =
      await mixer.getStats();
    const denomination = await mixer.denomination();
    const root = await mixer.getLastRoot();
    const paused = await mixer.paused();

    console.log("\n  ZK Mixer Status");
    console.log("  " + "=".repeat(40));
    console.log(`  Mixer:        ${addresses.mixer}`);
    console.log(`  Verifier:     ${addresses.verifier}`);
    if (addresses.depositReceipt) {
      console.log(`  Receipt NFT:  ${addresses.depositReceipt}`);
    }
    console.log(`  Network:      ${addresses.network ?? hre.network.name}`);
    console.log(
      `  Denomination: ${hre.ethers.formatEther(denomination)} ETH`
    );
    console.log(`  Deposits:     ${depCount}`);
    console.log(`  Withdrawals:  ${withCount}`);
    console.log(
      `  Total In:     ${hre.ethers.formatEther(totalDep)} ETH`
    );
    console.log(
      `  Total Out:    ${hre.ethers.formatEther(totalWith)} ETH`
    );
    console.log(`  Pool Balance: ${hre.ethers.formatEther(balance)} ETH`);
    console.log(
      `  Merkle Root:  0x${root.toString(16).substring(0, 16)}...`
    );
    console.log(`  Paused:       ${paused}`);
    console.log("  " + "=".repeat(40) + "\n");
  }
);
