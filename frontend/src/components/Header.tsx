import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function Header() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const handleConnect = () => {
    const connector = connectors[0];
    if (connector) {
      connect({ connector });
    }
  };

  return (
    <header className="border-b border-zinc-800 bg-zinc-950">
      <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-zinc-100">ZK Mixer</span>
          <Badge variant="secondary" className="text-xs">
            v1
          </Badge>
        </div>

        <div className="flex items-center gap-3">
          {isConnected && address ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-zinc-400 font-mono">
                {truncateAddress(address)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnect()}
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={handleConnect}>
              Connect Wallet
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
