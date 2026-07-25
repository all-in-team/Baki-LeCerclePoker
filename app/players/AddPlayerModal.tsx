"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Modal from "@/components/Modal";

const TIER_STYLE: Record<string, { color: string; bg: string }> = {
  S: { color: "#000", bg: "var(--gold)" },
  A: { color: "var(--green)", bg: "rgba(34,197,94,0.15)" },
  B: { color: "var(--text-muted)", bg: "rgba(136,136,160,0.15)" },
};

const LBL: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 };
const INP: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13, background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", boxSizing: "border-box" };

const BLANK = { name: "", telegram_handle: "", telegram_phone: "", tier: "A" as "S" | "A" | "B" };

// Reprise à l'identique de l'ancienne modale "Add Player" de app/players/PlayersClient.tsx
// (POST /api/players crée le joueur en status 'active' — les games/deals se règlent ensuite via Edit).
export default function AddPlayerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/players", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error ?? "Création refusée.");
        return;
      }
      setForm(BLANK);
      onClose();
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Player" width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={LBL}>Nom *</label>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Player name" autoFocus style={INP} />
        </div>
        <div>
          <label style={LBL}>Telegram handle</label>
          <input value={form.telegram_handle} onChange={e => setForm(f => ({ ...f, telegram_handle: e.target.value }))} placeholder="@handle" style={INP} />
        </div>
        <div>
          <label style={LBL}>Numéro Telegram (si pas de handle)</label>
          <input value={form.telegram_phone} onChange={e => setForm(f => ({ ...f, telegram_phone: e.target.value }))} placeholder="+33 6 12 34 56 78" style={INP} />
        </div>
        <div>
          <label style={LBL}>Tier</label>
          <div style={{ display: "flex", gap: 8 }}>
            {(["S", "A", "B"] as const).map(t => {
              const ts = TIER_STYLE[t];
              const active = form.tier === t;
              return (
                <button key={t} onClick={() => setForm(f => ({ ...f, tier: t }))} style={{
                  flex: 1, padding: "10px", borderRadius: 7, cursor: "pointer", fontWeight: 700, fontSize: 15,
                  border: active ? `2px solid ${ts.color === "#000" ? "var(--gold)" : ts.color}` : "1px solid var(--border)",
                  background: active ? ts.bg : "var(--bg-elevated)",
                  color: active ? ts.color : "var(--text-dim)",
                }}>
                  {t}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 }}>
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 7, fontSize: 13, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
            Annuler
          </button>
          <button onClick={submit} disabled={!form.name.trim() || busy} style={{
            padding: "8px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: busy ? "wait" : "pointer",
            background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E",
            opacity: !form.name.trim() || busy ? 0.5 : 1,
          }}>
            {busy ? "Saving…" : "Add Player"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
