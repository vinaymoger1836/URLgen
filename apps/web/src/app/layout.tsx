import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "URLGen",
  description: "Edge URL shortener with real-time analytics",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-plane text-ink antialiased">
        <header className="border-b border-hairline bg-surface">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
            <Link href="/" className="text-sm font-semibold text-ink">
              URLGen
            </Link>
            <span className="text-xs text-ink-3">Edge shortener &amp; analytics</span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
