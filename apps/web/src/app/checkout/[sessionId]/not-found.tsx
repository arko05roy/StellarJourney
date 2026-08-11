import { Card, CardContent } from "@/components/ui/card";

export default function CheckoutSessionNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-12">
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <h1 className="text-base font-semibold text-foreground">We could not find this checkout link</h1>
          <p className="text-sm text-muted-foreground">
            Double-check the link the merchant gave you, or ask them to send a new one.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
