import { ConnectForm } from "@/components/merchant/connect-form";
import { CreateMerchantForm } from "@/components/merchant/create-merchant-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * Deliberately does NOT redirect away when a session cookie already exists
 * (unlike every other `/merchant/**` page, which all guard via
 * `requireMerchantApiKey`). `createMerchantAction` sets the cookie *and*
 * needs this exact page to keep rendering afterward so `CreateMerchantForm`
 * can show the newly issued key exactly once (CLAUDE.md §10) — a
 * cookie-presence redirect here would fire the instant the Server Action's
 * cookie mutation lands (Next.js re-renders this route's Server Component
 * as part of that same action response) and race the client past the
 * success view before anyone could ever see the key. This page staying
 * reachable while connected is also a reasonable, honest affordance on its
 * own (creating a second merchant account, or reconnecting with a
 * different key) — `layout.tsx`'s "Disconnect" control and nav remain
 * available here too when connected.
 */
export default function MerchantConnectPage() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 py-10 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>New to Paymap</CardTitle>
          <CardDescription>Create a merchant account and get your first API key.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateMerchantForm />
        </CardContent>
      </Card>
      <div className="flex flex-col gap-6 md:hidden">
        <Separator />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Already have an API key</CardTitle>
          <CardDescription>Reconnect to an existing merchant account.</CardDescription>
        </CardHeader>
        <CardContent>
          <ConnectForm />
        </CardContent>
      </Card>
    </div>
  );
}
