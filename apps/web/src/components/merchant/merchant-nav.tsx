"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV_ITEMS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/merchant/products", label: "Products" },
  { href: "/merchant/checkout-links", label: "Checkout links" },
  { href: "/merchant/mandates", label: "Mandates" },
  { href: "/merchant/upcoming", label: "Upcoming" },
  { href: "/merchant/failed", label: "Failed" },
  { href: "/merchant/payments", label: "Payments" },
  { href: "/merchant/refunds", label: "Refunds" },
  { href: "/merchant/developers", label: "Developers" },
  { href: "/merchant/webhooks", label: "Webhooks" },
];

/** PLAN.md §16.3's nine-item merchant nav. Client Component only for `usePathname()`'s active-link highlight — reads no merchant data, imports nothing server-only (see `lib/no-secret-leak.test.ts`). */
export function MerchantNav() {
  const currentPath = usePathname();
  return (
    <nav aria-label="Merchant dashboard" className="border-b border-border">
      <ul className="flex flex-wrap gap-1 px-1 py-1" data-testid="merchant-nav">
        {NAV_ITEMS.map((item) => {
          const active = currentPath === item.href || currentPath.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                data-testid={`merchant-nav-${item.href.split("/").pop()}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-lg px-2.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
