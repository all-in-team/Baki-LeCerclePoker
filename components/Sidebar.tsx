"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, AppWindow, FileText, MessageSquare, TrendingUp, Zap, Wallet, ContactRound, Settings } from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/crm", label: "CRM Joueurs", icon: ContactRound },
  { href: "/apps", label: "Apps", icon: AppWindow },
  { href: "/wallets", label: "Wallet Tracker", icon: Wallet },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/ledger", label: "Telegram Ledger", icon: MessageSquare },
  { href: "/signals", label: "Weekly Signal", icon: Zap },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function Sidebar() {
  const path = usePathname();

  return (
    <aside style={{
      width: 220,
      minHeight: "100vh",
      background: "var(--bg-surface)",
      borderRight: "1px solid var(--border)",
      display: "flex",
      flexDirection: "column",
      position: "fixed",
      top: 0,
      left: 0,
      zIndex: 50,
    }}>
      {/* Logo */}
      <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "linear-gradient(135deg, var(--green), var(--gold))",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 800, color: "#000",
            flexShrink: 0,
          }}>♠</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>Le Cercle</div>
            <div style={{ fontSize: 10, color: "var(--gold)", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Poker</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: "12px 10px" }}>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = path === href;
          return (
            <Link key={href} href={href} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 10px", borderRadius: 7, marginBottom: 2,
              textDecoration: "none",
              background: active ? "rgba(34,197,94,0.12)" : "transparent",
              color: active ? "var(--green)" : "var(--text-muted)",
              fontWeight: active ? 600 : 400,
              fontSize: 13,
              transition: "all 0.15s",
              borderLeft: active ? "2px solid var(--green)" : "2px solid transparent",
            }}>
              <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>v1.0 · Local SQLite</div>
      </div>
    </aside>
  );
}
