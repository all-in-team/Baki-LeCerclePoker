import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Le Cercle Poker",
  description: "Poker affiliation management dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar />
        <main style={{
          marginLeft: 220,
          flex: 1,
          padding: "32px 36px",
          minHeight: "100vh",
          background: "var(--bg-base)",
        }}>
          {children}
        </main>
      </body>
    </html>
  );
}
