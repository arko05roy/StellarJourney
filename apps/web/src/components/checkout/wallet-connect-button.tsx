import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface WalletConnectButtonProps {
  connecting: boolean;
  onConnect: () => void;
}

export function WalletConnectButton({ connecting, onConnect }: WalletConnectButtonProps) {
  return (
    <Button type="button" size="lg" onClick={onConnect} disabled={connecting} className="w-full" data-testid="connect-wallet-button">
      <Wallet data-icon="inline-start" />
      {connecting ? "Connecting…" : "Connect your wallet"}
    </Button>
  );
}
