import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { getMixerAddress, MIXER_ABI, DEPLOY_BLOCK } from "@/lib/constants";

type HistoryEntry = {
  type: "deposit";
  commitment: string;
  leafIndex: number;
  timestamp: number;
  blockNumber: number;
};

export function HistoryCard() {
  const publicClient = usePublicClient();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchHistory() {
      if (!publicClient) return;
      try {
        const address = getMixerAddress();

        const depositLogs = await publicClient.getContractEvents({
          address,
          abi: MIXER_ABI,
          eventName: "Deposit",
          fromBlock: DEPLOY_BLOCK,
        });

        const entries: HistoryEntry[] = depositLogs.map((log) => ({
          type: "deposit" as const,
          commitment:
            log.args.commitment !== undefined
              ? log.args.commitment.toString().slice(0, 20) + "..."
              : "unknown",
          leafIndex: Number(log.args.leafIndex),
          timestamp: Number(log.args.timestamp),
          blockNumber: Number(log.blockNumber),
        }));

        entries.sort((a, b) => b.blockNumber - a.blockNumber);
        setHistory(entries.slice(0, 20));
      } catch {
        // Contract not deployed yet or RPC error — show empty list
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, [publicClient]);

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        {loading ? (
          <div className="animate-pulse space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-8 bg-zinc-800 rounded" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-zinc-500">No activity yet</p>
        ) : (
          <div className="space-y-2">
            {history.map((entry, i) => (
              <div
                key={i}
                className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="default">{entry.type}</Badge>
                  <span className="text-xs text-zinc-400 font-mono">
                    {entry.commitment}
                  </span>
                </div>
                <span className="text-xs text-zinc-500">
                  Block {entry.blockNumber}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
