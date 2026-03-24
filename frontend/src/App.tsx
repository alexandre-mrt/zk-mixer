import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "./lib/wagmi-config";
import { Header } from "./components/Header";
import { TabNav } from "./components/TabNav";
import { ErrorBoundary } from "./components/ErrorBoundary";

const queryClient = new QueryClient();

export function App() {
  return (
    <ErrorBoundary>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <div className="min-h-screen bg-zinc-950 text-white">
            <Header />
            <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
              <TabNav />
            </main>
          </div>
        </QueryClientProvider>
      </WagmiProvider>
    </ErrorBoundary>
  );
}

export default App;
