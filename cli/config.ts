import fs from "fs";
import path from "path";

export const DEFAULT_RPC_URL = "http://127.0.0.1:8545";
export const MERKLE_TREE_HEIGHT = 20;
export const DENOMINATION = "0.1"; // ETH

// Minimal ABI for the Mixer contract — covers all CLI-used functions and events.
const MINIMAL_MIXER_ABI = [
  "function deposit(uint256 commitment) payable",
  "function withdraw(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256 root, uint256 nullifierHash, address recipient, address relayer, uint256 fee)",
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "function denomination() view returns (uint256)",
  "function nullifierHashes(uint256) view returns (bool)",
  "event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
  "event Withdrawal(address to, uint256 nullifierHash, address indexed relayer, uint256 fee)",
];

/**
 * Load the Mixer ABI from compiled artifacts if available, otherwise fall back
 * to the minimal inline ABI. This allows the CLI to work before `hardhat compile`
 * has been run.
 */
export function loadMixerAbi(): string[] {
  const artifactPath = path.resolve(
    "artifacts/contracts/Mixer.sol/Mixer.json"
  );
  if (fs.existsSync(artifactPath)) {
    try {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
        abi: string[];
      };
      return artifact.abi;
    } catch {
      // Fall through to minimal ABI
    }
  }
  return MINIMAL_MIXER_ABI;
}

/**
 * Read mixer address from deployment.json if available.
 * Returns undefined if the file does not exist or lacks a mixer field.
 */
export function loadDeploymentAddress(): string | undefined {
  const deploymentPath = path.resolve("deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    return undefined;
  }
  try {
    const data = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as {
      mixer?: string;
    };
    return data.mixer;
  } catch {
    return undefined;
  }
}
