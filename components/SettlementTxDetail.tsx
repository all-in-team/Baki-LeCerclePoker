"use client";

import { useEffect, useState } from "react";
import { computeTotals, isCountable, statusBadge, sourceLabel, type HistoryTx } from "@/lib/wallet-history";

// Détail des transactions couvertes par un règlement — LECTURE SEULE.
//
// Déplié à la demande sous une ligne « Réglé N tx » de /payments. Chargé au
// premier dépliage puis gardé en mémoire : replier/déplier ne rappelle pas
// l'API.

function fmt(n: number): string {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function SettlementTxDetail({ settlementId }: { settlementId: number }) {
  const [rows, setRows] = useState<HistoryTx[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/wallets/settlement-transactions?settlement_id=${settlementId}`)
      .then(async r => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j;
      })
      .then(j => { if (alive) setRows(j.transactions ?? []); })
      .catch(e => { if (alive) setError(e.message ?? String(e)); });
    return () => { alive = false; };
  }, [settlementId]);

  const wrap: React.CSSProperties = {
    padding: "10px 16px 14px 16px", borderBottom: "1px solid var(--border)",
    background: "rgba(255,255,255,0.02)",
  };

  if (error) return <div style={{ ...wrap, fontSize: 11, color: "#EF4444" }}>Erreur : {error}</div>;
  if (rows === null) return <div style={{ ...wrap, fontSize: 11, color: "var(--text-dim)" }}>Chargement des transactions…</div>;
  if (rows.length === 0) return <div style={{ ...wrap, fontSize: 11, color: "var(--text-dim)" }}>Aucune transaction rattachée à ce règlement.</div>;

  const t = computeTotals(rows);

  return (
    <div style={wrap}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {["Date (UTC)", "Jeu", "Type", "Montant", "Source", "Statut", "Contrepartie"].map(h => (
              <th key={h} style={{ textAlign: h === "Montant" ? "right" : "left", padding: "5px 8px", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(tx => {
            const badge = statusBadge(tx);
            return (
              <tr key={tx.id} style={{ borderTop: "1px solid var(--border)", opacity: isCountable(tx) ? 1 : 0.6 }}>
                <td style={{ padding: "5px 8px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {(tx.tx_at ?? "").slice(0, 19).replace("T", " ").replace("Z", "")}
                </td>
                <td style={{ padding: "5px 8px", color: "var(--text-muted)" }}>{tx.game_name ?? "—"}</td>
                <td style={{ padding: "5px 8px", fontWeight: 600, color: tx.type === "deposit" ? "var(--green)" : "#f87171" }}>{tx.type === "deposit" ? "Dépôt" : "Retrait"}</td>
                <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap", color: tx.type === "deposit" ? "var(--green)" : "#f87171" }}>
                  {tx.type === "deposit" ? "+" : "−"}{fmt(tx.amount)} {tx.currency}
                </td>
                <td style={{ padding: "5px 8px", color: "var(--text-dim)" }}>{sourceLabel(tx.source)}</td>
                <td style={{ padding: "5px 8px" }}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 7px", borderRadius: 9, color: badge.color, background: badge.bg, whiteSpace: "nowrap" }}>
                    {badge.label}
                  </span>
                </td>
                <td style={{ padding: "5px 8px", fontFamily: "monospace", fontSize: 9, color: "var(--text-dim)" }}>
                  {tx.counterparty_address
                    ? <span title={tx.counterparty_address}>{tx.counterparty_address.slice(0, 8)}…{tx.counterparty_address.slice(-6)}</span>
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>{t.counted} tx comptée{t.counted > 1 ? "s" : ""}{t.excluded > 0 ? ` (+${t.excluded} hors totaux)` : ""}</span>
        <span>·</span>
        <span>Dépôts {fmt(t.deposited)}</span>
        <span>·</span>
        <span>Retraits {fmt(t.withdrawn)}</span>
        <span>·</span>
        <span style={{ fontWeight: 700, color: t.net >= 0 ? "var(--green)" : "#EF4444" }}>
          Net {t.net >= 0 ? "+" : ""}{fmt(t.net)}
        </span>
      </div>
    </div>
  );
}
