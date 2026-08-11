import { redirect } from "next/navigation";
import { getMerchantSessionToken } from "@/lib/merchant-session";

export default async function MerchantIndexPage() {
  const sessionToken = await getMerchantSessionToken();
  redirect(sessionToken !== undefined ? "/merchant/products" : "/merchant/connect");
}
