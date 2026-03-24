import "dotenv/config";
import { Command } from "commander";
import { ethers, formatEther } from "ethers";
import { loadMixerAbi, loadDeploymentAddress, DEFAULT_RPC_URL } from "./config";
import { getMixerContractReadOnly, resolveMixerAddress, toHex, log } from "./utils";

export const statusCommand = new Command("status")
  .description("Show current mixer contract status")
  .option("--rpc <url>", "RPC endpoint URL", DEFAULT_RPC_URL)
  .option("--mixer <address>", "Mixer contract address (or auto-read from deployment.json)")
  .addHelpText("after", `
Examples:
  $ zk-mixer status --mixer 0x...
  $ zk-mixer status (reads mixer address from deployment.json)
`)
  .action(async (opts: { rpc: string; mixer?: string }) => {
    try {
      if (opts.mixer !== undefined && !ethers.isAddress(opts.mixer)) {
        throw new Error(`Invalid mixer address: "${opts.mixer}"`);
      }

      const mixerAddress = resolveMixerAddress(opts.mixer, loadDeploymentAddress());
      const mixerAbi = loadMixerAbi();

      let contract: ReturnType<typeof getMixerContractReadOnly>["contract"];
      let provider: ReturnType<typeof getMixerContractReadOnly>["provider"];
      try {
        const result = getMixerContractReadOnly(opts.rpc, mixerAddress, mixerAbi);
        contract = result.contract;
        provider = result.provider;
      } catch (err) {
        throw new Error(`Failed to connect to RPC at ${opts.rpc}: ${(err as Error).message}`);
      }

      const [denomination, nextIndex, lastRoot, balance] = await Promise.all([
        contract.denomination() as Promise<bigint>,
        contract.nextIndex() as Promise<bigint>,
        contract.getLastRoot() as Promise<bigint>,
        provider.getBalance(mixerAddress),
      ]);

      console.log("\n====================================================");
      log.info("ZK MIXER STATUS");
      console.log("====================================================");
      log.step(`Contract:      ${mixerAddress}`);
      log.step(`RPC:           ${opts.rpc}`);
      log.step(`Denomination:  ${formatEther(denomination)} ETH`);
      log.step(`Deposits:      ${nextIndex.toString()}`);
      log.step(`ETH balance:   ${formatEther(balance)} ETH`);
      log.step(`Merkle root:   ${toHex(lastRoot)}`);
      console.log("====================================================\n");
    } catch (err) {
      log.error(`Status check failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
