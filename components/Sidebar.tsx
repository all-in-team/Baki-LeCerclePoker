"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  X, LogOut, LayoutDashboard, ContactRound, Users, Network,
  Sliders, Settings, Wallet, Scale, BarChart3, FileText,
  Gamepad2, Receipt, TrendingUp,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> };
type NavSection = { label: string; items: NavItem[]; archived?: boolean };

const SECTIONS: NavSection[] = [
  {
    label: "",
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/crm", label: "CRM Joueurs", icon: ContactRound },
      { href: "/players", label: "Joueurs", icon: Users },
      { href: "/crm/affiliates", label: "Affiliates", icon: Network },
      { href: "/crm/games", label: "Games & Deals", icon: Sliders },
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
  {
    label: "GRINDHOUSE",
    items: [
      { href: "/grindhouse/sessions", label: "Sessions", icon: Gamepad2 },
      { href: "/grindhouse/expenses", label: "Frais", icon: Receipt },
      { href: "/grindhouse/settlements", label: "Settlements", icon: Scale },
      { href: "/grindhouse/dashboard", label: "Dashboard", icon: TrendingUp },
    ],
  },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const path = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <aside
      className={`${isOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0`}
      style={{
        position: "fixed", top: 0, left: 0, zIndex: 50,
        display: "flex", flexDirection: "column",
        width: 260, height: "100vh",
        background: "rgba(10,9,20,0.78)",
        backdropFilter: "blur(22px)", WebkitBackdropFilter: "blur(22px)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
        transition: "transform 300ms ease-in-out",
      }}
    >
      {/* Logo */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "20px 20px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 12,
            background: "linear-gradient(135deg, #10B981, #F5C518)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, fontWeight: 800, color: "#000", letterSpacing: "-0.02em",
            boxShadow: "0 4px 16px rgba(16,185,129,0.2)",
            flexShrink: 0,
          }}>LC</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#E8E8EE", lineHeight: 1.2 }}>Le Cercle</div>
            <div style={{ fontSize: 10, color: "#F5C518", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Poker</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="lg:hidden flex items-center"
          style={{
            padding: 6, borderRadius: 6, background: "none", border: "none",
            color: "#555568", cursor: "pointer",
          }}
        >
          <X size={18} />
        </button>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, overflowY: "auto", padding: "12px 12px" }}>
        {SECTIONS.map((section) => (
          <div key={section.label || "_top"}>
            {section.label && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "14px 12px 6px",
                fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                color: section.archived ? "rgba(85,85,104,0.5)" : "#555568",
                borderTop: "1px solid rgba(255,255,255,0.04)", marginTop: 4,
              }}>
                {section.label}
                {section.archived && (
                  <span style={{
                    fontSize: 8, padding: "1px 5px", borderRadius: 3,
                    background: "rgba(255,255,255,0.05)", color: "#555568",
                    fontWeight: 600, letterSpacing: "0.04em",
                  }}>
                    ARCHIVED
                  </span>
                )}
              </div>
            )}
            {section.items.map(({ href, label, icon: Icon }) => {
              const active = path === href || (href !== "/" && path.startsWith(href));
              return (
                <Link key={href} href={href} className={active ? "nav-active" : undefined} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: section.label ? "8px 12px 8px 20px" : "9px 12px",
                  borderRadius: 10, marginBottom: 2,
                  textDecoration: "none",
                  fontSize: section.label ? 12 : 13,
                  fontWeight: active ? 600 : 400,
                  transition: "all 0.15s",
                  background: active ? "rgba(16,185,129,0.1)" : "transparent",
                  color: active ? "#10B981" : "#8888A0",
                  boxShadow: active ? "inset 3px 0 0 0 #10B981" : "none",
                  opacity: section.archived && !active ? 0.5 : 1,
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
      <div style={{
        padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.06)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontSize: 11, color: "#555568" }}>v1.0</span>
        <button onClick={handleLogout} title="Logout" style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "5px 10px", borderRadius: 6,
          fontSize: 10, fontWeight: 600, cursor: "pointer",
          background: "none", border: "1px solid rgba(255,255,255,0.06)", color: "#555568",
          transition: "all 0.15s",
        }}>
          <LogOut size={12} /> Logout
        </button>
      </div>
    </aside>
  );
}
