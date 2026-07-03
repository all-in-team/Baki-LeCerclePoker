"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import {
  X, LogOut, LayoutDashboard, ContactRound, Users, Network,
  Sliders, Settings, Wallet, Scale, BarChart3, FileText,
  TrendingUp, ChevronDown, ChevronRight, CalendarDays,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> };
type NavGroup = { label: string; archived?: boolean; items: NavItem[] };

const MAIN: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/crm", label: "CRM Joueurs", icon: ContactRound },
  { href: "/players", label: "Joueurs", icon: Users },
  { href: "/crm/affiliates", label: "Affiliates", icon: Network },
  { href: "/crm/games", label: "Games & Deals", icon: Sliders },
  { href: "/settings", label: "Settings", icon: Settings },
];

const GROUPS: NavGroup[] = [
  { label: "KKPOKER", items: [
    { href: "/kkpoker/pnl", label: "P&L", icon: Wallet },
    { href: "/kkpoker/settlements", label: "Settlements", icon: Scale },
  ]},
  // A5NUTS = merged A5POKER + NUTSPK dashboard (same owner, same wallets).
  // Old weekly /a5poker/settlements and /nutspk/settlements stay reachable by direct URL.
  { label: "A5NUTS", items: [
    { href: "/a5nuts/pnl", label: "P&L", icon: Wallet },
  ]},
  { label: "AKS", items: [
    { href: "/aks/pnl", label: "P&L", icon: Wallet },
    { href: "/aks/settlements", label: "Settlements", icon: Scale },
  ]},
  { label: "QQPK", items: [
    { href: "/qqpk/pnl", label: "P&L", icon: Wallet },
  ]},
  { label: "WEPOKER", items: [
    { href: "/wepoker/pnl", label: "P&L", icon: BarChart3 },
    { href: "/wepoker/settlements", label: "Settlements", icon: FileText },
  ]},
  { label: "AKPOKER", archived: true, items: [
    { href: "/akpoker/pnl", label: "P&L", icon: Wallet },
    { href: "/akpoker/settlements", label: "Settlements", icon: Scale },
  ]},
  { label: "GRINDHOUSE", items: [
    // Sessions / Frais / Settlements stay reachable by direct URL — just not in the nav
    { href: "/grindhouse/weekly", label: "Week results", icon: CalendarDays },
    { href: "/grindhouse/dashboard", label: "Dashboard", icon: TrendingUp },
  ]},
];

function groupContains(group: NavGroup, path: string): boolean {
  return group.items.some(i => path.startsWith(i.href));
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const path = usePathname();
  const router = useRouter();

  // collapsed by default, except the group holding the active page
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(GROUPS.map(g => [g.label, groupContains(g, path ?? "")])));
  useEffect(() => {
    const g = GROUPS.find(x => groupContains(x, path ?? ""));
    if (g) setOpen(o => (o[g.label] ? o : { ...o, [g.label]: true }));
  }, [path]);

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const itemStyle = (active: boolean, sub = false): React.CSSProperties => ({
    display: "flex", alignItems: "center", gap: 10,
    padding: sub ? "7px 12px" : "9px 14px",
    borderRadius: 999, marginBottom: 2,
    textDecoration: "none",
    fontSize: sub ? 12 : 13,
    fontWeight: active ? 600 : 400,
    transition: "background 0.15s, color 0.15s",
    background: active ? "rgba(16,185,129,0.10)" : "transparent",
    color: active ? "#10B981" : "#8888A0",
  });

  return (
    <aside className={`${isOpen ? "translate-x-0" : "-translate-x-full"} lg:translate-x-0 sidebar-panel`}>
      {/* Logo */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "18px 18px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12,
            background: "#11141A", border: "1px solid rgba(255,255,255,0.08)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <span style={{
              fontSize: 14, fontWeight: 800, letterSpacing: "-0.02em",
              background: "linear-gradient(120deg, #10B981, #F0B90B)",
              WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            }}>LC</span>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#E8E8EE", lineHeight: 1.2 }}>Le Cercle</div>
            <div style={{ fontSize: 10, color: "#F5C518", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase" }}>Private Club</div>
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
        {(() => {
          const p = path ?? "";
          // longest matching prefix wins ("/crm/affiliates" beats "/crm")
          const bestMain = MAIN
            .filter(m => p === m.href || (m.href !== "/" && p.startsWith(m.href)))
            .sort((a, b) => b.href.length - a.href.length)[0]?.href;
          return MAIN.map(({ href, label, icon: Icon }) => {
          const active = href === bestMain;
          return (
            <Link key={href} href={href} className={active ? "nav-active" : undefined} style={itemStyle(active)}>
              <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
              {label}
            </Link>
          );
          });
        })()}

        <div style={{ height: 10 }} />

        {GROUPS.map(group => {
          const isOpenGroup = open[group.label] ?? false;
          const hasActive = groupContains(group, path ?? "");
          return (
            <div key={group.label} style={{ opacity: group.archived && !hasActive ? 0.55 : 1, marginBottom: 2 }}>
              <button
                onClick={() => setOpen(o => ({ ...o, [group.label]: !isOpenGroup }))}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "8px 14px", borderRadius: 10,
                  background: "transparent", border: "none", cursor: "pointer",
                  fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                  color: hasActive ? "#8888A0" : "#555568",
                  transition: "color 0.15s",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {group.label}
                  {group.archived && (
                    <span style={{
                      fontSize: 8, padding: "1px 5px", borderRadius: 3,
                      background: "rgba(255,255,255,0.05)", color: "#555568",
                      fontWeight: 600, letterSpacing: "0.04em",
                    }}>
                      ARCHIVED
                    </span>
                  )}
                </span>
                {isOpenGroup ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>
              {isOpenGroup && (
                <div style={{
                  marginLeft: 19, paddingLeft: 9, marginBottom: 4,
                  borderLeft: "1px solid rgba(255,255,255,0.07)",
                }}>
                  {group.items.map(({ href, label, icon: Icon }) => {
                    const active = (path ?? "").startsWith(href);
                    return (
                      <Link key={href} href={href} className={active ? "nav-active" : undefined} style={itemStyle(active, true)}>
                        <Icon size={14} strokeWidth={active ? 2.2 : 1.8} />
                        {label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer mini-card */}
      <div style={{ padding: 12 }}>
        <div style={{
          padding: "10px 14px", borderRadius: 14,
          background: "#11141A", border: "1px solid rgba(255,255,255,0.06)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontSize: 11, color: "#555568" }}>v1.0</span>
          <button onClick={handleLogout} title="Logout" style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "5px 10px", borderRadius: 8,
            fontSize: 10, fontWeight: 600, cursor: "pointer",
            background: "none", border: "1px solid rgba(255,255,255,0.08)", color: "#8888A0",
            transition: "all 0.15s",
          }}>
            <LogOut size={12} /> Logout
          </button>
        </div>
      </div>
    </aside>
  );
}
