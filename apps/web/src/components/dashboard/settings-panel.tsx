import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export interface SettingsPanelProps {
  address: string;
  onDisconnect: () => void;
}

export function SettingsPanel({ address, onDisconnect }: SettingsPanelProps) {
  return (
    <Card data-testid="settings-panel">
      <CardHeader>
        <CardTitle>Wallet</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Wallet className="size-4 text-muted-foreground" />
            <span className="break-all font-mono text-sm text-foreground">{address}</span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onDisconnect} data-testid="disconnect-wallet-button">
            Disconnect
          </Button>
        </div>
        <Separator />
        <p className="text-sm text-muted-foreground">
          Every automatic payment, its limits, and its current status shown on this page are read directly from the Stellar network for
          this wallet address — never assumed from a database.
        </p>
      </CardContent>
    </Card>
  );
}
