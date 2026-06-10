import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AdminShell from "@/components/AdminShell";

const inter = Inter({ subsets: ["latin"], display: "swap" });
const jbMono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-jbmono" });

export const metadata: Metadata = {
  title: "Le Cercle Poker",
  description: "Poker affiliation management dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.className} ${jbMono.variable}`} style={{ display: "flex", minHeight: "100vh" }}>
        <div className="nebula" aria-hidden>
          <div className="nebula-blob nebula-b1" />
          <div className="nebula-blob nebula-b2" />
          <div className="nebula-blob nebula-b3" />
        </div>
        <AdminShell>{children}</AdminShell>
      </body>
    </html>
  );
}
