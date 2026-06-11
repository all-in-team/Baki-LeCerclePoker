"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Lock, Eye, Archive, RotateCcw } from "lucide-react";
import Modal from "@/components/Modal";

const GAME_COLORS: Record<string, { bg: string; color: string }> = {
  KKPOKER: { bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  Xpoker:  { bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
  ClubGG:  { bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
  TELE:    { bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
};

interface GameRow {
  id: number; name: string; status: string; currency: string;
  exact_action_pct: number | null; exact_rakeback_pct: number | null; exact_insurance_pct: number | null;
  perceived_action_pct: number | null; perceived_rakeback_pct: number | null; perceived_insurance_pct: number | null;
}

interface EditForm {
  exact_action_pct: string; exact_rakeback_pct: string; exact_insurance_pct: string;
  perceived_action_pct: string; perceived_rakeback_pct: string; perceived_insurance_pct: string;
  currency: string;        // one of COMMON_CURRENCIES or OTHER_CURRENCY
  customCurrency: string;  // free input when "Autre…"
}

const COMMON_CURRENCIES = ["USDT", "INR", "EUR", "USD", "CNY", "MYR"];
const OTHER_CURRENCY = "__other__";

interface Props { games: GameRow[]; }

const fmtPct = (v: number | null) => v != null ? `${v}%` : "—";
const labelStyle: React.CSSProperties = { fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", textAlign: "center", boxSizing: "border-box" };

export default function GamesConfigClient({ games }: Props) {
  const router = useRouter();
  const [editGame, setEditGame] = useState<GameRow | null>(null);
  const [form, setForm] = useState<EditForm>({ exact_action_pct: "", exact_rakeback_pct: "", exact_insurance_pct: "", perceived_action_pct: "", perceived_rakeback_pct: "", perceived_insurance_pct: "", currency: "USDT", customCurrency: "" });
  const [saving, setSaving] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const activeGames = games.filter(g => g.status === "active");
  const archivedGames = games.filter(g => g.status === "archived");

  function openEdit(g: GameRow) {
    setEditGame(g);
    const cur = (g.currency ?? "USDT").toUpperCase();
    const isCommon = COMMON_CURRENCIES.includes(cur);
    setForm({
      exact_action_pct: g.exact_action_pct != null ? String(g.exact_action_pct) : "",
      exact_rakeback_pct: g.exact_rakeback_pct != null ? String(g.exact_rakeback_pct) : "",
      exact_insurance_pct: g.exact_insurance_pct != null ? String(g.exact_insurance_pct) : "",
      perceived_action_pct: g.perceived_action_pct != null ? String(g.perceived_action_pct) : "",
      perceived_rakeback_pct: g.perceived_rakeback_pct != null ? String(g.perceived_rakeback_pct) : "",
      perceived_insurance_pct: g.perceived_insurance_pct != null ? String(g.perceived_insurance_pct) : "",
      currency: isCommon ? cur : OTHER_CURRENCY,
      customCurrency: isCommon ? "" : cur,
    });
  }

  async function handleSave() {
    if (!editGame) return;
    const currency = (form.currency === OTHER_CURRENCY ? form.customCurrency : form.currency).trim().toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(currency)) { alert("Currency invalide (3-5 lettres, ex: INR)"); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/games/${editGame.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exact_action_pct: form.exact_action_pct ? Number(form.exact_action_pct) : null,
          exact_rakeback_pct: form.exact_rakeback_pct ? Number(form.exact_rakeback_pct) : null,
          exact_insurance_pct: form.exact_insurance_pct ? Number(form.exact_insurance_pct) : null,
          perceived_action_pct: form.perceived_action_pct ? Number(form.perceived_action_pct) : null,
          perceived_rakeback_pct: form.perceived_rakeback_pct ? Number(form.perceived_rakeback_pct) : null,
          perceived_insurance_pct: form.perceived_insurance_pct ? Number(form.perceived_insurance_pct) : null,
          currency,
        }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error ?? "Erreur"); return; }
      setEditGame(null);
      router.refresh();
    } catch (e: any) { alert(e.message); } finally { setSaving(false); }
  }

  async function toggleArchive(g: GameRow) {
    const newStatus = g.status === "active" ? "archived" : "active";
    if (newStatus === "archived" && !confirm(`Archiver ${g.name} ? Les agents ne verront plus ce game.`)) return;
    try {
      const res = await fetch(`/api/games/${g.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error ?? "Erreur"); return; }
      router.refresh();
    } catch (e: any) { alert(e.message); }
  }

  function renderRateBox(label: string, icon: React.ReactNode, action: number | null, rb: number | null, ins: number | null, accent: string) {
    return (
      <div style={{ flex: 1, padding: "10px 12px", background: "var(--bg-base)", borderRadius: 8, border: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 10, fontWeight: 700, color: accent, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          {icon} {label}
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {[{ l: "Action", v: action }, { l: "Rakeback", v: rb }, { l: "Insurance", v: ins }].map(r => (
            <div key={r.l} style={{ flex: 1, textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "var(--text-dim)", marginBottom: 2 }}>{r.l}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: r.v != null ? "var(--text)" : "var(--text-dim)" }}>{fmtPct(r.v)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderGameCard(g: GameRow, dimmed?: boolean) {
    const gc = GAME_COLORS[g.name] ?? { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };
    return (
      <div key={g.id} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", opacity: dimmed ? 0.5 : 1 }}>
        <div style={{ padding: "12px 16px", background: "var(--bg-surface)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ background: gc.bg, color: gc.color, padding: "3px 10px", borderRadius: 5, fontSize: 12, fontWeight: 700 }}>{g.name}</span>
            <span style={{
              fontSize: 9, padding: "2px 7px", borderRadius: 3, fontWeight: 700, letterSpacing: "0.05em",
              background: g.currency === "USDT" ? "rgba(34,197,94,0.10)" : "rgba(245,158,11,0.12)",
              color: g.currency === "USDT" ? "#22C55E" : "#F59E0B",
            }}>{g.currency ?? "USDT"}</span>
            {g.status === "archived" && <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(156,163,175,0.15)", color: "#9CA3AF", fontWeight: 600 }}>ARCHIVED</span>}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {g.status === "active" && (
              <button onClick={() => openEdit(g)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
                <Pencil size={12} /> Editer
              </button>
            )}
            <button onClick={() => toggleArchive(g)} title={g.status === "active" ? "Archiver" : "Restaurer"}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-dim)" }}>
              {g.status === "active" ? <Archive size={12} /> : <RotateCcw size={12} />}
              {g.status === "active" ? "" : " Restore"}
            </button>
          </div>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", gap: 12 }}>
          {renderRateBox("Exact Deal", <Lock size={10} />, g.exact_action_pct, g.exact_rakeback_pct, g.exact_insurance_pct, "var(--text-muted)")}
          {renderRateBox("Perceived Deal", <Eye size={10} />, g.perceived_action_pct, g.perceived_rakeback_pct, g.perceived_insurance_pct, "#22C55E")}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 28px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {activeGames.map(g => renderGameCard(g))}
        {activeGames.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)" }}>Aucun game actif</div>}
      </div>

      {archivedGames.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <button onClick={() => setShowArchived(!showArchived)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--text-dim)", padding: "8px 0", fontWeight: 600 }}>
            {showArchived ? "▾" : "▸"} Archived ({archivedGames.length})
          </button>
          {showArchived && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
              {archivedGames.map(g => renderGameCard(g, true))}
            </div>
          )}
        </div>
      )}

      <Modal open={!!editGame} onClose={() => setEditGame(null)} title={`${editGame?.name ?? ""} — Deals`} width={520}>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ flex: 1, padding: "12px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              <Lock size={11} /> Exact Deal
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {([["exact_action_pct", "Action %"], ["exact_rakeback_pct", "Rakeback %"], ["exact_insurance_pct", "Insurance %"]] as const).map(([k, label]) => (
                <div key={k}>
                  <label style={labelStyle}>{label}</label>
                  <input type="number" step="0.01" min={0} max={100} value={(form as any)[k]}
                    onChange={e => setForm({ ...form, [k]: e.target.value })} placeholder="—" style={inputStyle} />
                </div>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, padding: "12px", background: "rgba(34,197,94,0.04)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, fontSize: 11, fontWeight: 700, color: "#22C55E", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              <Eye size={11} /> Perceived Deal
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {([["perceived_action_pct", "Action %"], ["perceived_rakeback_pct", "Rakeback %"], ["perceived_insurance_pct", "Insurance %"]] as const).map(([k, label]) => (
                <div key={k}>
                  <label style={labelStyle}>{label}</label>
                  <input type="number" step="0.01" min={0} max={100} value={(form as any)[k]}
                    onChange={e => setForm({ ...form, [k]: e.target.value })} placeholder="—" style={inputStyle} />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 14, padding: "12px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>Currency</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={form.currency}
              onChange={e => setForm({ ...form, currency: e.target.value })}
              style={{ ...inputStyle, textAlign: "left", width: "auto", minWidth: 120 }}
            >
              {COMMON_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              <option value={OTHER_CURRENCY}>Autre…</option>
            </select>
            {form.currency === OTHER_CURRENCY && (
              <input
                type="text" placeholder="ex: THB" maxLength={5}
                value={form.customCurrency}
                onChange={e => setForm({ ...form, customCurrency: e.target.value.toUpperCase() })}
                style={{ ...inputStyle, width: 90 }}
              />
            )}
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Pas de conversion auto — les montants de cette game restent dans sa devise.</span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 10, padding: "8px 0" }}>
          <strong>Perceived</strong> = rates communiques aux agents. Utilise auto pour le calcul commission affiliate.
          <br /><strong>Exact</strong> = rates reels internes (usage futur stats owner).
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 }}>
          <button onClick={() => setEditGame(null)} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Annuler</button>
          <button onClick={handleSave} disabled={saving} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving ? 0.5 : 1 }}>
            {saving ? "..." : "Sauvegarder"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
