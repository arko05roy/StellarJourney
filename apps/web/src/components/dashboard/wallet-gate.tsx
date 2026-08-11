import { Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { WalletConnectButton } from "@/components/checkout/wallet-connect-button";

export interface WalletGateProps {
  connecting: boolean;
  onConnect: () => void;
}

/** A real, explanatory empty state (not just a spinner) for a first-time or logged-out visitor — CLAUDE.md §13 / the task's explicit "real empty states" requirement. */
export function WalletGate({ connecting, onConnect }: WalletGateProps) {
  return (
    <Card data-testid="wallet-gate">
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <Wallet className="size-8 text-muted-foreground" />
        <div>
          <p className="text-base font-medium text-foreground">Connect your wallet to view your automatic payments</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            This page shows every automatic payment you've authorized, straight from the Stellar network — pause, resume, or cancel
            any of them, and review your payment history.
          </p>
        </div>
        <div className="mt-2 w-full max-w-xs">
          <WalletConnectButton connecting={connecting} onConnect={onConnect} />
        </div>
      </CardContent>
    </Card>
  );
}
