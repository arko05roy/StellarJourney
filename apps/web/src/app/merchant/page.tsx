import { redirect } from "next/navigation";
import { getMerchantApiKey } from "@/lib/merchant-session";

export default async function MerchantIndexPage() {
  const apiKey = await getMerchantApiKey();
  redirect(apiKey !== undefined ? "/merchant/products" : "/merchant/connect");
}
