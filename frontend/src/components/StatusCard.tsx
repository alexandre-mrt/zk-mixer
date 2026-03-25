import { useReadContract, useBalance, useAccount } from "wagmi";
import { formatEther } from "viem";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MIXER_ABI, getMixerAddress } from "@/lib/constants";

function truncateBigInt(value: bigint): string {
  const hex = value.toString(16);
  return `0x${hex.slice(0, 8)}...${hex.slice(-6)}`;
}

export function StatusCard() {
  const { isConnected } = useAccount();

  const { data: nextIndex } = useReadContract({
    address: getMixerAddress(),
    abi: MIXER_ABI,
    functionName: "nextIndex",
  });

  const { data: lastRoot } = useReadContract({
    address: getMixerAddress(),
    abi: MIXER_ABI,
    functionName: "getLastRoot",
  });

  const { data: balanceData } = useBalance({
    address: getMixerAddress(),
  });

  const { data: stats } = useReadContract({
    address: getMixerAddress(),
    abi: MIXER_ABI,
    functionName: "getStats",
  });

  const { data: poolHealth } = useReadContract({
    address: getMixerAddress(),
    abi: MIXER_ABI,
    functionName: "getPoolHealth",
  });

  const totalDeposited = stats?.[0];
  const totalWithdrawn = stats?.[1];
  const anonymitySetSize = poolHealth?.[0];
  const treeUtilization = poolHealth?.[1];
  const poolHealthPaused = poolHealth?.[3];

  if (!isConnected) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardContent className="flex items-center justify-center py-12">
          <p className="text-sm text-zinc-400">Connect your wallet to continue</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Pool Status
          <Badge variant="secondary" className="text-xs font-normal">
            Live
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3">
          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Total Deposits</span>
            <span className="font-mono font-semibold text-zinc-100">
              {nextIndex !== undefined ? nextIndex.toString() : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Contract Balance</span>
            <span className="font-mono font-semibold text-zinc-100">
              {balanceData
                ? `${parseFloat(formatEther(balanceData.value)).toFixed(4)} ETH`
                : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Current Merkle Root</span>
            <span className="font-mono text-xs text-zinc-300">
              {lastRoot !== undefined ? truncateBigInt(lastRoot) : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Total Deposited (cumul.)</span>
            <span className="font-mono font-semibold text-emerald-400">
              {totalDeposited !== undefined
                ? `${parseFloat(formatEther(totalDeposited)).toFixed(4)} ETH`
                : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Total Withdrawn (cumul.)</span>
            <span className="font-mono font-semibold text-rose-400">
              {totalWithdrawn !== undefined
                ? `${parseFloat(formatEther(totalWithdrawn)).toFixed(4)} ETH`
                : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Denomination</span>
            <span className="font-mono font-semibold text-emerald-400">
              0.1 ETH
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Anonymity Set Size</span>
            <span className="font-mono font-semibold text-violet-400">
              {anonymitySetSize !== undefined ? anonymitySetSize.toString() : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Tree Utilization</span>
            <span className="font-mono font-semibold text-zinc-100">
              {treeUtilization !== undefined ? `${treeUtilization.toString()}%` : "—"}
            </span>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-zinc-800 px-4 py-3">
            <span className="text-sm text-zinc-400">Pool Status</span>
            <span className={`font-mono font-semibold ${poolHealthPaused ? "text-rose-400" : "text-emerald-400"}`}>
              {poolHealthPaused === undefined ? "—" : poolHealthPaused ? "Paused" : "Active"}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
