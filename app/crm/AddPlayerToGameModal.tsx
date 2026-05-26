"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/Modal";

interface Player { id: number; name: string; telegram_handle: string | null; status: string; }
interface Game { id: number; name: string; default_action_pct: number | null; status: string; }

interface Props {
  open: boolean;
  onClose: () => void;
  game: Game;
  existingPlayerIds: Set<number>;
  allPlayers: Player[];
}

export default function AddPlayerToGameModal({ open, onClose, game, existingPlayerIds, allPlayers }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [actionPct, setActionPct] = useState(String(game.default_action_pct ?? 50));
  const [rakebackPct, setRakebackPct] = useState("0");
  const [saving, setSaving] = useState(false);

  const candidates = allPlayers
    .filter(p => !existingPlayerIds.has(p.id) && (p.status === "active" || p.status === "signed"))
    .filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || (p.telegram_handle ?? "").toLowerCase().includes(search.toLowerCase()));

  async function handleSave() {
    if (!selectedId) return;
    setSaving(true);
    try {
      await fetch("/api/games/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player_id: selectedId,
          game_id: game.id,
          action_pct: Number(actionPct),
          rakeback_pct: Number(rakebackPct),
        }),
      });
      onClose();
      setSearch("");
      setSelectedId(null);
      setActionPct(String(game.default_action_pct ?? 50));
      setRakebackPct("0");
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Ajouter joueur à ${game.name}`} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          placeholder="Chercher joueur..."
          value={search}
          onChange={e => { setSearch(e.target.value); setSelectedId(null); }}
          style={{ width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" }}
        />
        <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
          {candidates.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>Aucun joueur disponible</div>}
          {candidates.slice(0, 20).map(p => (
            <button key={p.id} onClick={() => setSelectedId(p.id)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "8px 12px", fontSize: 12, cursor: "pointer",
              border: "none", borderBottom: "1px solid var(--border)",
              background: selectedId === p.id ? "rgba(34,197,94,0.10)" : "transparent",
              color: selectedId === p.id ? "var(--green)" : "var(--text)",
              fontWeight: selectedId === p.id ? 600 : 400,
            }}>
              {p.name}
              {p.telegram_handle && <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>@{p.telegram_handle}</span>}
            </button>
          ))}
        </div>

        {selectedId && (
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 }}>Action %</label>
              <input type="number" min={0} max={100} value={actionPct} onChange={e => setActionPct(e.target.value)}
                style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box", textAlign: "center" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 3 }}>Rakeback %</label>
              <input type="number" min={0} max={100} value={rakebackPct} onChange={e => setRakebackPct(e.target.value)}
                style={{ width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 12, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box", textAlign: "center" }} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
            Annuler
          </button>
          <button onClick={handleSave} disabled={saving || !selectedId} style={{
            padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: saving ? "wait" : "pointer",
            background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E",
            opacity: saving || !selectedId ? 0.5 : 1,
          }}>
            {saving ? "..." : "Ajouter"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
