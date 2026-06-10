import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import AdminShell from "@/components/AdminShell";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Le Cercle Poker",
  description: "Poker affiliation management dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className} style={{ display: "flex", minHeight: "100vh" }}>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
