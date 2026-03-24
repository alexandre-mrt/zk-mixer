import "dotenv/config";
import { Command } from "commander";
import { formatEther } from "ethers";
import { loadMixerAbi, loadDeploymentAddress, DEFAULT_RPC_URL } from "./config";
import { getMixerContractReadOnly, resolveMixerAddress, toHex } from "./utils";

export const statusCommand = new Command("status")
  .description("Show current mixer contract status")
  .option("--rpc <url>", "RPC endpoint URL", DEFAULT_RPC_URL)
  .option("--mixer <address>", "Mixer contract address (or auto-read from deployment.json)")
  .action(async (opts: { rpc: string; mixer?: string }) => {
    try {
      const mixerAddress = resolveMixerAddress(opts.mixer, loadDeploymentAddress());
      const mixerAbi = loadMixerAbi();

      const { contract, provider } = getMixerContractReadOnly(opts.rpc, mixerAddress, mixerAbi);

      const [denomination, nextIndex, lastRoot, balance] = await Promise.all([
        contract.denomination() as Promise<bigint>,
        contract.nextIndex() as Promise<bigint>,
        contract.getLastRoot() as Promise<bigint>,
        provider.getBalance(mixerAddress),
      ]);

      console.log("\n====================================================");
      console.log("ZK MIXER STATUS");
      console.log("====================================================");
      console.log(`Contract:      ${mixerAddress}`);
      console.log(`RPC:           ${opts.rpc}`);
      console.log(`Denomination:  ${formatEther(denomination)} ETH`);
      console.log(`Deposits:      ${nextIndex.toString()}`);
      console.log(`ETH balance:   ${formatEther(balance)} ETH`);
      console.log(`Merkle root:   ${toHex(lastRoot)}`);
      console.log("====================================================\n");
    } catch (err) {
      console.error("Status check failed:", (err as Error).message);
      process.exit(1);
    }
  });
