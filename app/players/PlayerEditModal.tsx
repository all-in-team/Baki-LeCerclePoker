"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/Modal";
import { badgeFor, isActiveStatus, type App, type Deal, type Game, type Player } from "./shared";

interface Props {
  player: Player | null;
  dealsByPlayer: Record<number, Deal[]>;
  activeGames: Game[];
  apps: App[];
  affiliatedByPlayer: Record<number, { name: string; handle: string | null }>;
  onClose: () => void;
}

type DealDraft = { checked: boolean; action_pct: string; rakeback_pct: string; had_deal: boolean; deal_id: number | null; end_date: string | null };

const LBL: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 };
const INP: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };

// Modale d'édition unique de la page Joueurs (avant : dupliquée entre CRMListClient et CRMKanbanView,
// et une 3e version dans PlayersClient qui portait seule telegram_phone / notes / tron_address).
// Pas de suppression définitive ici : elle vit sur la fiche joueur uniquement.
export default function PlayerEditModal({ player, dealsByPlayer, activeGames, apps, affiliatedByPlayer, onClose }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  // Formulaire monté à l'ouverture (le composant est remonté via key={player.id} par le parent).
  const [form, setForm] = useState(() => ({
    name: player?.name ?? "",
    tier: player?.tier ?? "B",
    status: player?.status ?? "active",
    telegram_handle: player?.telegram_handle ?? "",
    telegram_phone: player?.telegram_phone ?? "",
    notes: player?.notes ?? "",
    tron_address: player?.tron_address ?? "",
    tron_app_id: player?.tron_app_id ? String(player.tron_app_id) : "",
  }));

  const [dealForm, setDealForm] = useState<Record<number, DealDraft>>(() => {
    const deals = player ? dealsByPlayer[player.id] ?? [] : [];
    const df: Record<number, DealDraft> = {};
    for (const g of activeGames) {
      const existing = deals.find(d => d.game_id === g.id);
      df[g.id] = existing
        ? { checked: !existing.end_date, action_pct: String(existing.action_pct), rakeback_pct: String(existing.rakeback_pct), had_deal: true, deal_id: existing.deal_id, end_date: existing.end_date }
        : { checked: false, action_pct: String(g.default_action_pct ?? 50), rakeback_pct: "0", had_deal: false, deal_id: null, end_date: null };
    }
    return df;
  });

  if (!player) return null;
  const p = player;

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/players/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          tier: form.tier,
          status: form.status,
          telegram_handle: form.telegram_handle.trim() || null,
          telegram_phone: form.telegram_phone.trim() || null,
          notes: form.notes.trim() || null,
          tron_address: form.tron_address.trim() || null,
          tron_app_id: form.tron_app_id ? Number(form.tron_app_id) : null,
        }),
      });

      for (const g of activeGames) {
        const df = dealForm[g.id];
        if (!df) continue;
        if (df.checked) {
          await fetch("/api/games/deals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ player_id: p.id, game_id: g.id, action_pct: Number(df.action_pct), rakeback_pct: Number(df.rakeback_pct), end_date: null }),
          });
        } else if (df.had_deal && !df.end_date) {
          const today = new Date().toISOString().slice(0, 10);
          await fetch("/api/games/deals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ player_id: p.id, game_id: g.id, action_pct: Number(df.action_pct), rakeback_pct: Number(df.rakeback_pct), end_date: today }),
          });
        }
      }

      onClose();
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  // Archive = soft, même sémantique que le bouton de la ligne (inactive / active).
  async function toggleArchive() {
    setSaving(true);
    try {
      const newStatus = isActiveStatus(p.status) ? "inactive" : "active";
      await fetch(`/api/players/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      onClose();
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  const affiliatedBy = affiliatedByPlayer[p.id];

  return (
    <Modal open onClose={onClose} title={`Edit — ${p.name}${p.telegram_handle ? ` @${p.telegram_handle}` : ""}`} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={LBL}>Nom</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={INP} />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Tier</label>
            <select value={form.tier} onChange={e => setForm({ ...form, tier: e.target.value })} style={INP}>
              <option value="S">S</option>
              <option value="A">A</option>
              <option value="B">B</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Status</label>
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={INP}>
              <option value="active">Active</option>
              <option value="signed">Signed</option>
              <option value="inactive">Inactive</option>
              <option value="churned">Churned</option>
            </select>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Telegram handle</label>
            <input value={form.telegram_handle} onChange={e => setForm({ ...form, telegram_handle: e.target.value })} placeholder="@handle" style={INP} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Numéro Telegram</label>
            <input value={form.telegram_phone} onChange={e => setForm({ ...form, telegram_phone: e.target.value })} placeholder="+33 6 12 34 56 78" style={INP} />
          </div>
        </div>

        <div>
          <label style={LBL}>Notes</label>
          <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Optionnel" style={{ ...INP, resize: "vertical" }} />
        </div>

        {(p.telegram_id || p.joined_via || p.created_at) && (
          <div style={{ padding: "10px 12px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border)" }}>
            <label style={LBL}>Origine</label>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
              {p.telegram_id && <><span style={{ color: "var(--text-dim)" }}>Telegram ID</span><span style={{ color: "var(--text)", fontFamily: "monospace" }}>{p.telegram_id}</span></>}
              {p.telegram_handle && <><span style={{ color: "var(--text-dim)" }}>Handle</span><span style={{ color: "var(--text)" }}>@{p.telegram_handle}</span></>}
              <span style={{ color: "var(--text-dim)" }}>Source</span><span style={{ color: "var(--text)" }}>{p.joined_via ?? "— (avant tracking)"}</span>
              <span style={{ color: "var(--text-dim)" }}>Créé le</span><span style={{ color: "var(--text)" }}>{p.created_at ? p.created_at.slice(0, 10) : "—"}</span>
              {affiliatedBy && <>
                <span style={{ color: "var(--text-dim)" }}>Affilié par</span>
                <span style={{ color: "#A78BFA", fontWeight: 600 }}>{affiliatedBy.handle ? `@${affiliatedBy.handle}` : affiliatedBy.name}</span>
              </>}
            </div>
          </div>
        )}

        <div>
          <label style={{ ...LBL, marginBottom: 8 }}>Games & Deals</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {activeGames.filter(g => g.status === "active").map(g => {
              const df = dealForm[g.id];
              if (!df) return null;
              const badge = badgeFor(g.name);
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

        {/* Legacy AKPOKER (TELE) : seul endroit de l'app où ces 2 colonnes sont saisissables. */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <label style={{ ...LBL, color: "var(--gold)" }}>TELE WT — adresse Tron (legacy)</label>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 2 }}>
              <input value={form.tron_address} onChange={e => setForm({ ...form, tron_address: e.target.value.trim() })} placeholder="TXxx..." style={INP} />
            </div>
            <div style={{ flex: 1 }}>
              <select value={form.tron_app_id} onChange={e => setForm({ ...form, tron_app_id: e.target.value })} style={INP}>
                <option value="">App…</option>
                {apps.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button disabled={saving} onClick={toggleArchive} style={{ padding: "8px 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
            {isActiveStatus(p.status) ? "Archiver" : "Réactiver"}
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
            Annuler
          </button>
          <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer", background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E", opacity: saving || !form.name.trim() ? 0.5 : 1 }}>
            {saving ? "Saving..." : "Sauvegarder"}
          </button>
        </div>

        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
          Suppression définitive : depuis la fiche joueur.
        </div>
      </div>
    </Modal>
  );
}
