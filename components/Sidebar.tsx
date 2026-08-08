"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import {
  X, LogOut, LayoutDashboard, Users, Network,
  Sliders, Settings, Wallet, BarChart3,
  TrendingUp, ChevronDown, ChevronRight, CalendarDays, Rocket, Banknote, GitMerge,
  MousePointerClick,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> };
type NavGroup = { label: string; items: NavItem[] };

const MAIN: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  // /crm et /players ont fusionné en une seule page Joueurs (/crm redirige).
  { href: "/players", label: "Joueurs", icon: Users },
  { href: "/payments", label: "Paiements", icon: Banknote },
  { href: "/crm/affiliates", label: "Affiliates", icon: Network },
  // QQPK Funnel a rejoint le groupe FUNNEL plus bas (avec NEXAPOKER).
  { href: "/crm/games", label: "Games & Deals", icon: Sliders },
  // File d'arbitrage des groupes : les rapprochements que le système refuse de trancher
  // seul (un @ ressemblant n'est pas une preuve d'identité). Vide la plupart du temps.
  { href: "/group-cases", label: "Groupes à trancher", icon: GitMerge },
  { href: "/settings", label: "Settings", icon: Settings },
];

// Rooms actives — une seule page utile (P&L), donc lien DIRECT, pas d'accordéon
// (Baki 2026-07-26). Les vues hebdo legacy /xxx/settlements existent toujours et
// restent joignables par URL directe : elles sont juste sorties de la nav. Le flow
// de règlement (preview → lock → payé) vit de toute façon dans LedgerTable, rendu
// sur la page P&L elle-même.
//   A5NUTS  = fusion A5POKER + NUTSPK (même owner, mêmes wallets).
//   AKS/OK POKER = fusion AKS + OKPOKER (même club, même wallet mère,
//                  deux skins d'onboarding) ; /okpoker/pnl redirige vers /aks/pnl.
//   NEXAPOKER a DEUX entrées, et c'est voulu : /nexapoker est la room (joueurs,
//                  parts d'action, réconciliation du report d'affiliation), tandis
//                  que /nexa-funnel reste le funnel d'acquisition, dans son groupe.
//                  Le funnel reste le funnel — les leads n'y sont pas des joueurs.
const ROOMS: NavItem[] = [
  { href: "/kkpoker/pnl", label: "KKPOKER", icon: Wallet },
  { href: "/a5nuts/pnl", label: "A5NUTS", icon: Wallet },
  { href: "/aks/pnl", label: "AKS/OK POKER", icon: Wallet },
  { href: "/nexapoker", label: "NEXAPOKER", icon: Wallet },
];

const GROUPS: NavGroup[] = [
  // FUNNEL : rooms d'acquisition pure (funnel bot + report hebdo), pas de P&L
  // staking — les leads ne sont pas des players.
  // À ne pas confondre avec la room QQPK (/qqpk/pnl), rangée dans ARCHIVE.
  { label: "FUNNEL", items: [
    { href: "/nexa-funnel", label: "NEXAPOKER", icon: Rocket },
    { href: "/qqpk-funnel", label: "QQPK", icon: Rocket },
    // Acquisition payante RichAds → groupe dzpk. Ce n'est PAS un funnel bot :
    // pas de lead, pas de /start, la destination est un lien d'invitation de
    // groupe. On ne mesure donc que le clic — la conversion vient du report
    // agent du club, hors système.
    { href: "/richads", label: "RichAds (dzpk)", icon: MousePointerClick },
  ]},
  { label: "GRINDHOUSE", items: [
    // Sessions / Frais / Settlements stay reachable by direct URL — just not in the nav
    { href: "/grindhouse/weekly", label: "Week results", icon: CalendarDays },
    { href: "/grindhouse/dashboard", label: "Dashboard", icon: TrendingUp },
  ]},
  // ARCHIVE : dossier replié par défaut, comme tout groupe (cf. `open` plus bas).
  // Rangement PUREMENT VISUEL : `games.status` n'est pas touché en base, le sync
  // wallets et les règlements de ces rooms tournent toujours. Pour un archivage
  // fonctionnel, passer par le toggle /crm/games.
  { label: "ARCHIVE", items: [
    { href: "/wepoker/pnl", label: "WEPOKER", icon: BarChart3 },
    { href: "/qqpk/pnl", label: "QQPK", icon: Wallet },
    { href: "/jvip/pnl", label: "JVIP", icon: Wallet },
    { href: "/ttpoker/pnl", label: "TTPOKER", icon: Wallet },
    { href: "/akpoker/pnl", label: "AKPOKER", icon: Wallet },
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

  // Anti-oubli — pastille "Paiements" visible depuis n'importe quelle page.
  // Rouge = semaines jamais réglées (un joueur zappé), jaune = règlements lockés
  // en attente de paiement. Refetch à chaque navigation pour rester à jour après
  // un paiement. Silencieux en cas d'erreur : la pastille disparaît, rien ne casse.
  // Une panne ne fait PAS disparaître la pastille (ce serait lu comme "rien à faire") :
  // elle affiche un "!" gris qui renvoie quand même vers la page.
  const [payAlerts, setPayAlerts] = useState<{ pending: number; overdue: number; failed: boolean }>({ pending: 0, overdue: 0, failed: false });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/payments/alerts")
      .then(r => r.json())
      .then(d => { if (!cancelled) setPayAlerts({ pending: d.pending ?? 0, overdue: d.overdue ?? 0, failed: !!d.failed }); })
      .catch(() => { if (!cancelled) setPayAlerts({ pending: 0, overdue: 0, failed: true }); });
    return () => { cancelled = true; };
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

  // Les rooms sont des liens directs, mais gardent une identité de "section" :
  // majuscule légèrement espacée, un cran plus dense que les entrées MAIN.
  const roomStyle = (active: boolean): React.CSSProperties => ({
    ...itemStyle(active),
    fontSize: 12,
    fontWeight: active ? 700 : 600,
    letterSpacing: "0.06em",
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
          const badge = href !== "/payments" ? null
            : payAlerts.failed
              ? { n: "!", color: "#8888A0", title: "Compteurs indisponibles — ouvre la page pour vérifier" }
              : payAlerts.overdue > 0
                ? { n: String(payAlerts.overdue), color: "#EF4444", title: `${payAlerts.overdue} semaine(s) jamais réglée(s)` }
                : payAlerts.pending > 0
                  ? { n: String(payAlerts.pending), color: "#F5C518", title: `${payAlerts.pending} règlement(s) à payer` }
                  : null;
          return (
            <Link key={href} href={href} className={active ? "nav-active" : undefined} style={itemStyle(active)}>
              <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
              {label}
              {badge && (
                <span title={badge.title} style={{
                  marginLeft: "auto", minWidth: 18, textAlign: "center",
                  fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 999,
                  background: `${badge.color}22`, color: badge.color, border: `1px solid ${badge.color}55`,
                }}>{badge.n}</span>
              )}
            </Link>
          );
          });
        })()}

        <div style={{ height: 10 }} />

        {ROOMS.map(({ href, label, icon: Icon }) => {
          const active = (path ?? "").startsWith(href);
          return (
            <Link key={href} href={href} className={active ? "nav-active" : undefined} style={roomStyle(active)}>
              <Icon size={15} strokeWidth={active ? 2.2 : 1.8} />
              {label}
            </Link>
          );
        })}

        <div style={{ height: 6, marginTop: 6, borderTop: "1px solid rgba(255,255,255,0.05)" }} />

        {GROUPS.map(group => {
          const isOpenGroup = open[group.label] ?? false;
          const hasActive = groupContains(group, path ?? "");
          return (
            <div key={group.label} style={{ marginBottom: 2 }}>
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
