import { MerchantAuthPanel } from "@/components/merchant/merchant-auth-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveWebDeployment } from "@/lib/network";

export const dynamic = "force-dynamic";

export default function MerchantConnectPage() {
  const deployment = resolveWebDeployment();

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
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-lg">First merchant setup</CardTitle>
          <CardDescription>
            Complete these steps once to start collecting bounded testnet payments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-4 text-sm" aria-label="Merchant setup checklist">
            <li className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                1
              </span>
              <span>
                Open Freighter and switch it to Stellar testnet. Use the wallet that should receive
                merchant settlements.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                2
              </span>
              <span>
                Connect and sign the one-time ownership message above. This does not submit a
                transaction or request funds.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                3
              </span>
              <span>Create your merchant profile, then add a product with its payment limits.</span>
            </li>
            <li className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                4
              </span>
              <span>
                Generate a checkout link and share it with a payer. Every mandate remains bounded
                by its on-chain terms.
              </span>
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
