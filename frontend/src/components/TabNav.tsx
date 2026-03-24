import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DepositCard } from "./DepositCard";
import { WithdrawCard } from "./WithdrawCard";
import { StatusCard } from "./StatusCard";

export function TabNav() {
  return (
    <Tabs defaultValue="deposit" className="w-full">
      <div className="overflow-x-auto">
      <TabsList className="w-full mb-6">
        <TabsTrigger value="deposit" className="flex-1">
          Deposit
        </TabsTrigger>
        <TabsTrigger value="withdraw" className="flex-1">
          Withdraw
        </TabsTrigger>
        <TabsTrigger value="status" className="flex-1">
          Status
        </TabsTrigger>
      </TabsList>
      </div>

      <TabsContent value="deposit">
        <DepositCard />
      </TabsContent>

      <TabsContent value="withdraw">
        <WithdrawCard />
      </TabsContent>

      <TabsContent value="status">
        <StatusCard />
      </TabsContent>
    </Tabs>
  );
}
