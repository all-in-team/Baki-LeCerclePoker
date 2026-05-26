"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pencil, Archive, RotateCcw } from "lucide-react";
import Modal from "@/components/Modal";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  Xpoker:  { short: "XP", bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
  ClubGG:  { short: "CG", bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
};
const BADGE_FALLBACK = { short: "??", bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };

interface Player { id: number; name: string; telegram_handle: string | null; status: string; tier: string | null; last_note_at: string | null; }
interface Deal { deal_id: number; player_id: number; game_id: number; action_pct: number; rakeback_pct: number; start_date: string | null; end_date: string | null; }
interface Game { id: number; name: string; default_action_pct: number | null; status: string; }

interface Props {
  players: Player[];
  gamesByPlayer: Record<number, string[]>;
  dealsByPlayer: Record<number, Deal[]>;
  agencyByPlayer: Record<number, number>;
  activeGames: Game[];
}

function fmtAmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}`;
}

export default function CRMListClient({ players, gamesByPlayer, dealsByPlayer, agencyByPlayer, activeGames }: Props) {
  const router = useRouter();
  const [editPlayer, setEditPlayer] = useState<Player | null>(null);
  const [form, setForm] = useState({ name: "", tier: "B", status: "active" });
  const [dealForm, setDealForm] = useState<Record<number, { checked: boolean; action_pct: string; rakeback_pct: string; had_deal: boolean; deal_id: number | null; end_date: string | null }>>({});
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState<number | null>(null);

  function openEdit(p: Player) {
    setEditPlayer(p);
    setForm({ name: p.name, tier: p.tier ?? "B", status: p.status });
    const deals = dealsByPlayer[p.id] ?? [];
    const df: Record<number, { checked: boolean; action_pct: string; rakeback_pct: string; had_deal: boolean; deal_id: number | null; end_date: string | null }> = {};
    for (const g of activeGames) {
      const existing = deals.find(d => d.game_id === g.id);
      df[g.id] = existing
        ? { checked: !existing.end_date, action_pct: String(existing.action_pct), rakeback_pct: String(existing.rakeback_pct), had_deal: true, deal_id: existing.deal_id, end_date: existing.end_date }
        : { checked: false, action_pct: String(g.default_action_pct ?? 50), rakeback_pct: "0", had_deal: false, deal_id: null, end_date: null };
    }
    setDealForm(df);
  }

  async function handleSave() {
    if (!editPlayer) return;
    setSaving(true);
    try {
      await fetch(`/api/players/${editPlayer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, tier: form.tier, status: form.status }),
      });

      for (const g of activeGames) {
        const df = dealForm[g.id];
        if (!df) continue;
        if (df.checked) {
          await fetch("/api/games/deals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              player_id: editPlayer.id,
              game_id: g.id,
              action_pct: Number(df.action_pct),
              rakeback_pct: Number(df.rakeback_pct),
              end_date: null,
            }),
          });
        } else if (df.had_deal && !df.end_date) {
          const today = new Date().toISOString().slice(0, 10);
          await fetch("/api/games/deals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              player_id: editPlayer.id,
              game_id: g.id,
              action_pct: Number(df.action_pct),
              rakeback_pct: Number(df.rakeback_pct),
              end_date: today,
            }),
          });
        }
      }

      setEditPlayer(null);
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive(p: Player) {
    setArchiving(p.id);
    try {
      const newStatus = p.status === "active" || p.status === "signed" ? "inactive" : "active";
      await fetch(`/api/players/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setArchiving(null);
    }
  }

  return (
    <div style={{ padding: "0 28px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            <th style={{ textAlign: "left", padding: "8px" }}>Joueur</th>
            <th style={{ textAlign: "center", padding: "8px" }}>Games</th>
            <th style={{ textAlign: "left", padding: "8px" }}>Dernière note</th>
            <th style={{ textAlign: "right", padding: "8px" }}>Agency cut 30j</th>
            <th style={{ textAlign: "center", padding: "8px" }}>Status</th>
            <th style={{ textAlign: "center", padding: "8px" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {players.map(p => {
            const agency30 = agencyByPlayer[p.id] ?? 0;
            const playerGames = gamesByPlayer[p.id] ?? [];
            return (
              <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "10px 8px" }}>
                  <Link href={`/crm/${p.id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                    {p.name}
                  </Link>
                  {p.telegram_handle && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 6 }}>@{p.telegram_handle}</span>}
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
                  {playerGames.map(gn => {
                    const b = GAME_BADGES[gn] ?? BADGE_FALLBACK;
                    return <span key={gn} style={{ background: b.bg, color: b.color, padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, marginRight: 4, display: "inline-block" }}>{b.short}</span>;
                  })}
                </td>
                <td style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-muted)" }}>
                  {p.last_note_at ? p.last_note_at.slice(0, 10) : "—"}
                </td>
                <td style={{ textAlign: "right", padding: "10px 8px", fontWeight: 600, color: agency30 > 0 ? "#D4AF37" : agency30 < 0 ? "#EF4444" : "var(--text-muted)" }}>
                  {agency30 !== 0 ? `${fmtAmt(agency30)} USDT` : "—"}
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
                  <span style={{
                    padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                    background: p.status === "active" ? "rgba(16,185,129,0.15)" : "rgba(156,163,175,0.15)",
                    color: p.status === "active" ? "#10B981" : "var(--text-muted)",
                  }}>{p.status}</span>
                </td>
                <td style={{ textAlign: "center", padding: "10px 8px" }}>
                  <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
                    <button onClick={() => openEdit(p)} title="Edit" style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 6px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => toggleArchive(p)}
                      disabled={archiving === p.id}
                      title={p.status === "active" || p.status === "signed" ? "Archiver" : "Réactiver"}
                      style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 6px", color: "var(--text-muted)", display: "flex", alignItems: "center", opacity: archiving === p.id ? 0.4 : 1 }}
                    >
                      {p.status === "active" || p.status === "signed" ? <Archive size={13} /> : <RotateCcw size={13} />}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Modal open={!!editPlayer} onClose={() => setEditPlayer(null)} title={`Edit — ${editPlayer?.name ?? ""}`} width={520}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Nom</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Tier</label>
              <select value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })} style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }}>
                <option value="S">S</option>
                <option value="A">A</option>
                <option value="B">B</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>Status</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none" }}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="churned">Churned</option>
              </select>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 8 }}>Games & Deals</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activeGames.map(g => {
                const df = dealForm[g.id];
                if (!df) return null;
                const badge = GAME_BADGES[g.name] ?? BADGE_FALLBACK;
                return (
                  <div key={g.id} style={{ padding: "10px 12px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={df.checked}
                        onChange={e => setDealForm({ ...dealForm, [g.id]: { ...df, checked: e.target.checked } })}
                        style={{ accentColor: badge.color }}
                      />
                      <span style={{ background: badge.bg, color: badge.color, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{badge.short}</span>
                      <span style={{ color: "var(--text)", fontWeight: 600 }}>{g.name}</span>
                      {df.end_date && !df.checked && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>Archivé le {df.end_date}</span>}
                    </label>
                    {df.checked && (
                      <div style={{ display: "flex", gap: 12, marginTop: 8, paddingLeft: 28 }}>
                        <div>
                          <label style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 }}>Action %</label>
                          <input
                            type="number" min={0} max={100} step={1}
                            value={df.action_pct}
                            onChange={e => setDealForm({ ...dealForm, [g.id]: { ...df, action_pct: e.target.value } })}
                            style={{ width: 70, padding: "6px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-raised)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textAlign: "center" }}
                          />
                        </div>
                        <div>
                          <label style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 }}>Rakeback %</label>
                          <input
                            type="number" min={0} max={100} step={1}
                            value={df.rakeback_pct}
                            onChange={e => setDealForm({ ...dealForm, [g.id]: { ...df, rakeback_pct: e.target.value } })}
                            style={{ width: 70, padding: "6px 8px", borderRadius: 6, fontSize: 12, background: "var(--bg-raised)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textAlign: "center" }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
            <button onClick={() => setEditPlayer(null)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              Annuler
            </button>
            <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.name.trim() ? 0.5 : 1 }}>
              {saving ? "Saving..." : "Sauvegarder"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
