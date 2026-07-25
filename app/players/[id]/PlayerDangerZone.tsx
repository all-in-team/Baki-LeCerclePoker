"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Suppression définitive : uniquement ici (fiche joueur), avec confirmation.
// La liste /players n'expose que edit + archive (soft).
export default function PlayerDangerZone({ playerId, playerName, status }: { playerId: number; playerName: string; status: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const isActive = status === "active" || status === "signed";

  async function archive() {
    setBusy(true);
    try {
      await fetch(`/api/players/${playerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: isActive ? "inactive" : "active" }),
      });
      router.refresh();
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function hardDelete() {
    setBusy(true);
    try {
      const res = await fetch(`/api/players/${playerId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error ?? "Suppression refusée.");
        return;
      }
      router.push("/players");
    } catch (e: any) {
      alert("Erreur: " + (e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginTop: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>
        Zone dangereuse
      </div>
      {confirm ? (
        <div style={{ padding: 14, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#EF4444", marginBottom: 8 }}>Supprimer {playerName} ?</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 12 }}>
            Action IRRÉVERSIBLE. Tous les deals, wallets, transactions et sessions seront supprimés.
            Un joueur avec un historique financier sera refusé par le garde-fou serveur — utilise Archiver.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={() => setConfirm(false)} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              Annuler
            </button>
            <button disabled={busy} onClick={hardDelete} style={{ padding: "6px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: busy ? "wait" : "pointer", background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#EF4444", opacity: busy ? 0.5 : 1 }}>
              {busy ? "..." : "Confirmer suppression"}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button disabled={busy} onClick={archive} style={{ padding: "8px 14px", borderRadius: 7, fontSize: 12, cursor: busy ? "wait" : "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
            {isActive ? "Archiver (soft)" : "Réactiver"}
          </button>
          <button onClick={() => setConfirm(true)} style={{ padding: "8px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#EF4444" }}>
            Supprimer définitivement
          </button>
        </div>
      )}
    </div>
  );
}
