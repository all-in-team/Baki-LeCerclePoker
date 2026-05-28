"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FileText, ContactRound, Settings, BarChart3, Scale, Wallet, Users, Network, Gamepad2 } from "lucide-react";

type NavItem = { href: string; label: string; icon: any };
type NavSection = { label: string; items: NavItem[]; archived?: boolean };

const SECTIONS: NavSection[] = [
  {
    label: "",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/crm", label: "CRM Joueurs", icon: ContactRound },
      { href: "/players", label: "Joueurs", icon: Users },
      { href: "/crm/affiliates", label: "Affiliates", icon: Network },
      { href: "/grindhouse", label: "Grindhouse", icon: Gamepad2 },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
  {
    label: "KKPOKER",
    items: [
      { href: "/kkpoker/pnl", label: "P&L", icon: Wallet },
      { href: "/kkpoker/settlements", label: "Settlements", icon: Scale },
    ],
  },
  {
    label: "A5POKER",
    items: [
      { href: "/a5poker/pnl", label: "P&L", icon: Wallet },
      { href: "/a5poker/settlements", label: "Settlements", icon: Scale },
    ],
  },
  {
    label: "WEPOKER",
    items: [
      { href: "/wepoker/pnl", label: "P&L", icon: BarChart3 },
      { href: "/wepoker/settlements", label: "Settlements", icon: FileText },
    ],
  },
  {
    label: "AKPOKER",
    archived: true,
    items: [
      { href: "/akpoker/pnl", label: "P&L", icon: Wallet },
      { href: "/akpoker/settlements", label: "Settlements", icon: Scale },
    ],
  },
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
        {SECTIONS.map((section) => (
          <div key={section.label || "_top"} style={{ marginBottom: section.label ? 4 : 0 }}>
            {section.label && (
              <div style={{
                fontSize: 10, fontWeight: 700, color: "var(--text-dim)",
                letterSpacing: "0.08em", textTransform: "uppercase",
                padding: "12px 10px 4px", marginTop: 4,
                borderTop: "1px solid var(--border)",
                opacity: section.archived ? 0.5 : 1,
                display: "flex", alignItems: "center", gap: 6,
              }}>
                {section.label}
                {section.archived && (
                  <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 3, background: "rgba(255,255,255,0.08)", color: "var(--text-dim)", fontWeight: 600, letterSpacing: "0.04em" }}>
                    ARCHIVED
                  </span>
                )}
              </div>
            )}
            {section.items.map(({ href, label, icon: Icon }) => {
              const active = path === href || (href !== "/" && path.startsWith(href));
              return (
                <Link key={href} href={href} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: section.label ? "7px 10px 7px 18px" : "9px 10px",
                  borderRadius: 7, marginBottom: 1,
                  textDecoration: "none",
                  background: active ? "rgba(34,197,94,0.12)" : "transparent",
                  color: active ? "var(--green)" : "var(--text-muted)",
                  fontWeight: active ? 600 : 400,
                  fontSize: section.label ? 12 : 13,
                  transition: "all 0.15s",
                  borderLeft: active ? "2px solid var(--green)" : "2px solid transparent",
                  opacity: section.archived ? 0.5 : 1,
                }}>
                  <Icon size={section.label ? 14 : 16} strokeWidth={active ? 2.2 : 1.8} />
                  {label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>v1.0 · Local SQLite</div>
      </div>
    </aside>
  );
}
