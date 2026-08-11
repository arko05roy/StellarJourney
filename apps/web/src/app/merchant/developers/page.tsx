import { requireMerchantApiKey } from "@/lib/merchant-guard";
import { RotateApiKeyPanel } from "@/components/merchant/rotate-api-key-panel";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default async function DevelopersPage() {
  await requireMerchantApiKey();

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>Used to authenticate every merchant API request and the Paymap SDK (`Authorization: Bearer &lt;key&gt;`).</CardDescription>
        </CardHeader>
        <CardContent>
          <RotateApiKeyPanel />
        </CardContent>
      </Card>
    </div>
  );
}
