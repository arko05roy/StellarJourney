import { requireMerchantSession } from "@/lib/merchant-guard";
import { listMerchantApiKeys } from "@/lib/merchant-api";
import { ApiKeyManager } from "@/components/merchant/api-key-manager";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DevelopersPage() {
  const sessionToken = await requireMerchantSession();
  const keys = await listMerchantApiKeys(sessionToken);

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Developer access</CardTitle>
          <CardDescription>
            Create scoped API keys for the Paymap SDK and your server. Wallet sign-in remains
            separate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyManager keys={keys} />
        </CardContent>
      </Card>
    </div>
  );
}
