import { useReadContract, useBalance } from "wagmi";
import { formatEther } from "viem";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MIXER_ABI, MIXER_ADDRESS } from "@/lib/constants";

function truncateBigInt(value: bigint): string {
  const hex = value.toString(16);
  return `0x${hex.slice(0, 8)}...${hex.slice(-6)}`;
}

export function StatusCard() {
  const { data: nextIndex } = useReadContract({
    address: MIXER_ADDRESS,
    abi: MIXER_ABI,
    functionName: "nextIndex",
  });

  const { data: lastRoot } = useReadContract({
    address: MIXER_ADDRESS,
    abi: MIXER_ABI,
    functionName: "getLastRoot",
  });

  const { data: balanceData } = useBalance({
    address: MIXER_ADDRESS,
  });

  return (
    <Card>
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
            <span className="text-sm text-zinc-400">Denomination</span>
            <span className="font-mono font-semibold text-emerald-400">
              0.1 ETH
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
