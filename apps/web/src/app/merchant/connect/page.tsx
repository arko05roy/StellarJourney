import { loadDeployment } from "@paymap/contract-client";
import { MerchantAuthPanel } from "@/components/merchant/merchant-auth-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

export default function MerchantConnectPage() {
  const deployment = loadDeployment(resolveNetwork());

  return (
    <div className="mx-auto w-full max-w-lg py-10">
      <Card>
        <CardHeader>
          <CardTitle>Merchant sign in</CardTitle>
          <CardDescription>
            Connect the Stellar wallet that receives your Paymap settlements.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MerchantAuthPanel networkPassphrase={deployment.networkPassphrase} />
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-xs text-muted-foreground">
        API keys are created after sign-in under Developers. They are never used as your dashboard
        password.
      </p>
    </div>
  );
}
