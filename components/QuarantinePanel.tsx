"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { QuarantinedTx } from "@/lib/queries";

// Arbitrage des mouvements wallet en quarantaine.
//
// Une ligne ici est déjà en base mais N'ENTRE dans aucun solde ni règlement :
// le sync l'a mise de côté parce que son montant dépasse le seuil de
// vraisemblance (100 000 USDT). Tant que personne ne tranche, elle ne peut pas
// corrompre un chiffre — c'est tout l'intérêt.
//
// Deux issues : « Valider » (status='active', la ligne rejoint les calculs) ou
// « Rejeter » (status='rejected', conservée pour l'audit, jamais comptée).

function fmtAmount(n: number, currency: string) {
  if (!Number.isFinite(n)) return `${n} ${currency}`;
  // Un montant de quarantaine peut être absurde (2^256/10^6) : la notation
  // scientifique reste lisible là où toLocaleString produirait 70 chiffres.
  if (Math.abs(n) >= 1e15) return `${n.toExponential(4)} ${currency}`;
  return `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ${currency}`;
}

export default function QuarantinePanel({
  transactions,
  showPlayer = false,
}: {
  transactions: QuarantinedTx[];
  showPlayer?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<number, string>>({});

  if (transactions.length === 0) return null;

  async function arbitrate(id: number, decision: "approve" | "reject") {
    const label = decision === "approve" ? "VALIDER" : "REJETER";
    const tx = transactions.find((t) => t.id === id);
    if (!confirm(`${label} la transaction #${id} — ${fmtAmount(tx?.amount ?? 0, tx?.currency ?? "USDT")} ?\n\n` +
      (decision === "approve"
        ? "Elle entrera immédiatement dans les soldes et les règlements."
        : "Elle sera marquée rejetée et restera hors de tout calcul."))) return;

    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/wallets/quarantine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDone((d) => ({ ...d, [id]: json.status }));
      router.refresh();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{
      background: "var(--bg-raised)", border: "1px solid #F59E0B", borderRadius: 12,
      padding: 20, marginBottom: 16,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>⚠️</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#F59E0B" }}>
          Quarantaine — {transactions.length} mouvement{transactions.length > 1 ? "s" : ""} en attente
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>
        Montant au-delà du seuil de vraisemblance. Ces lignes ne sont comptées dans
        <b> aucun solde ni règlement</b> tant qu&apos;elles n&apos;ont pas été validées.
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "#EF4444", marginBottom: 10 }}>Erreur : {error}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {transactions.map((tx) => {
          const settled = done[tx.id];
          return (
            <div key={tx.id} style={{
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
              border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px",
              opacity: settled ? 0.5 : 1,
            }}>
              <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>
                  {showPlayer && <span>{tx.player_name} · </span>}
                  {tx.game_name ?? "—"} · {tx.type === "deposit" ? "Dépôt" : "Retrait"} ·{" "}
                  <span style={{ color: "#F59E0B" }}>{fmtAmount(tx.amount, tx.currency)}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "monospace", overflowWrap: "anywhere" }}>
                  #{tx.id} · {(tx.tx_datetime ?? tx.tx_date ?? "").slice(0, 19).replace("T", " ")}
                  {tx.counterparty_address ? ` · de ${tx.counterparty_address}` : ""}
                </div>
              </div>

              {settled ? (
                <span style={{ fontSize: 12, color: settled === "active" ? "var(--green)" : "var(--text-dim)" }}>
                  {settled === "active" ? "✓ validée" : "✕ rejetée"}
                </span>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => arbitrate(tx.id, "approve")}
                    disabled={busy !== null}
                    style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                      border: "1px solid var(--green)", background: "transparent",
                      color: "var(--green)", cursor: busy === null ? "pointer" : "wait",
                    }}
                  >{busy === tx.id ? "…" : "Valider"}</button>
                  <button
                    onClick={() => arbitrate(tx.id, "reject")}
                    disabled={busy !== null}
                    style={{
                      padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                      border: "1px solid #EF4444", background: "transparent",
                      color: "#EF4444", cursor: busy === null ? "pointer" : "wait",
                    }}
                  >{busy === tx.id ? "…" : "Rejeter"}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
