import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Paymap | Recurring payments, on your terms",
  description:
    "Non-custodial recurring payments on Stellar with exact amount, timing, and revocation controls.",
};

// Sets `.dark` before first paint based on system preference (no manual
// toggle in this phase's scope). This avoids a light-to-dark flash and keeps
// the theme in one place rather than duplicating the check in every page.
const THEME_INIT_SCRIPT = `(function(){try{var d=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
