import "dotenv/config";
import { Command } from "commander";
import { ethers } from "ethers";
import { loadMixerAbi, loadDeploymentAddress, DEFAULT_RPC_URL } from "./config";
import { resolveMixerAddress, log } from "./utils";

export const watchCommand = new Command("watch")
  .description("Watch for real-time deposit and withdrawal events")
  .option("--rpc <url>", "RPC endpoint URL", DEFAULT_RPC_URL)
  .option("--mixer <address>", "Mixer contract address")
  .addHelpText(
    "after",
    `
Examples:
  $ zk-mixer watch
  $ zk-mixer watch --rpc ws://localhost:8545
`
  )
  .action(async (opts: { rpc?: string; mixer?: string }) => {
    try {
      const mixerAddress = resolveMixerAddress(opts.mixer, loadDeploymentAddress());
      const abi = loadMixerAbi();

      // Use WebSocket provider for real-time events, fallback to polling HTTP
      let provider: ethers.Provider;
      const rpcUrl = opts.rpc ?? DEFAULT_RPC_URL;
      if (rpcUrl.startsWith("ws")) {
        provider = new ethers.WebSocketProvider(rpcUrl);
      } else {
        provider = new ethers.JsonRpcProvider(rpcUrl);
      }

      const contract = new ethers.Contract(mixerAddress, abi, provider);

      log.info(`Watching events on ${mixerAddress}...`);
      log.info("Press Ctrl+C to stop\n");

      contract.on("Deposit", (commitment: bigint, leafIndex: bigint, timestamp: bigint) => {
        const time = new Date(Number(timestamp) * 1000).toISOString();
        log.success(
          `[DEPOSIT] Leaf #${leafIndex} | Commitment: ${commitment.toString(16).substring(0, 16)}... | ${time}`
        );
      });

      contract.on("Withdrawal", (to: string, nullifierHash: bigint, relayer: string, fee: bigint) => {
        log.success(
          `[WITHDRAW] To: ${to} | NullifierHash: ${nullifierHash.toString(16).substring(0, 16)}... | Fee: ${ethers.formatEther(fee)} ETH`
        );
      });

      // Keep process alive
      await new Promise(() => {});
    } catch (err) {
      log.error(`Watch failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });
