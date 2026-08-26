import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AUS Delta Bag Room — Ops Platform",
  description:
    "Live Delta departure feed, disruption detection and automated bag room reporting for Austin-Bergstrom.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-[var(--bg)] text-[var(--fg)]">
        {children}
      </body>
    </html>
  );
}
