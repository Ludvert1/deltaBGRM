import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AUS Delta Bag Room — Live Ops Platform",
  description:
    "Live Delta departure feed, disruption detection and automated bag room reporting for Austin-Bergstrom.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
