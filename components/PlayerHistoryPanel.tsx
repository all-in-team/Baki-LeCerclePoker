"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Download, History } from "lucide-react";
import PeriodFilterBar from "@/components/PeriodFilterBar";
import { resolvePlayersPeriod, periodRangeLabel, type PlayersPeriod } from "@/app/players/shared";
import {
  filterHistory, computeTotals, statusBadge, sourceLabel, historyToCsv, isCountable,
  type HistoryTx, type TxTypeFilter, type TxStatusFilter,
} from "@/lib/wallet-history";

// Section « Historique » de la fiche joueur — 100 % lecture.
//
// Toutes les lignes du joueur depuis le début, réglées comprises, avec la
// quarantaine visible mais hors totaux. Aucun appel d'écriture ici : le
// composant reçoit ses lignes du serveur et ne fait que filtrer/afficher.
//
// Les filtres vivent en état LOCAL et pas dans l'URL : la fiche joueur utilise
// déjà `?range=` pour le graphe agency, et re-router à chaque clic rechargerait
// toute la page (P&L, graphe, notes) pour un tableau qui tient en mémoire.

const TYPES: { key: TxTypeFilter; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "deposit", label: "Dépôts" },
  { key: "withdrawal", label: "Retraits" },
];

const STATUSES: { key: TxStatusFilter; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "unsettled", label: "Non réglées" },
  { key: "settled", label: "Réglées" },
  { key: "quarantined", label: "Hors totaux" },
];

function fmt(n: number): string {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 12px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
      border: active ? "1px solid var(--green)" : "1px solid var(--border)",
      background: active ? "rgba(34,197,94,0.12)" : "var(--bg-surface)",
      color: active ? "var(--green)" : "var(--text-muted)",
    }}>{children}</button>
  );
}

export default function PlayerHistoryPanel({
  playerId, playerName, transactions, dealBoundedNet,
}: {
  playerId: number;
  playerName: string;
  transactions: HistoryTx[];
  /**
   * Net des cartes P&L (getPlayerWalletStats, borné aux fenêtres de deal).
   * Sert UNIQUEMENT à afficher une note de rapprochement quand il diffère du
   * total lifetime brut — pour que l'écart se lise, au lieu de passer pour une
   * contradiction entre deux endroits de la même fiche.
   */
  dealBoundedNet: number | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [filterKey, setFilterKey] = useState("lifetime");
  const [type, setType] = useState<TxTypeFilter>("all");
  const [status, setStatus] = useState<TxStatusFilter>("all");

  const period: PlayersPeriod = useMemo(
    () => (filterKey === "lifetime" ? { key: "lifetime", kind: "lifetime" } : resolvePlayersPeriod(filterKey, today)),
    [filterKey, today],
  );

  const rows = useMemo(
    () => filterHistory(transactions, period, type, status),
    [transactions, period, type, status],
  );
  const totals = useMemo(() => computeTotals(rows), [rows]);

  // Écart avec les cartes P&L : calculé sur le LIFETIME brut, pas sur la vue
  // filtrée (comparer un 7 jours à un lifetime n'aurait aucun sens).
  const lifetimeNet = useMemo(() => computeTotals(transactions.filter(isCountable)).net, [transactions]);
  const gap = dealBoundedNet == null ? 0 : lifetimeNet - dealBoundedNet;
  const showGap = Math.abs(gap) > 0.01;

  function downloadCsv() {
    const blob = new Blob([historyToCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${playerName.replace(/[^\w-]+/g, "_")}-transactions-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginTop: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <History size={14} color="#38bdf8" />
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            Historique — {transactions.length} mouvement{transactions.length > 1 ? "s" : ""} depuis le début
          </span>
        </div>
        <button onClick={downloadCsv} disabled={rows.length === 0} style={{
          display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 7,
          fontSize: 12, fontWeight: 600, border: "1px solid var(--border)", background: "var(--bg-surface)",
          color: rows.length === 0 ? "var(--text-dim)" : "var(--text-muted)",
          cursor: rows.length === 0 ? "not-allowed" : "pointer",
        }}>
          <Download size={12} /> Export CSV ({rows.length})
        </button>
      </div>

      <PeriodFilterBar
        activeFilter={period.key}
        rangeLabel={period.kind === "lifetime" ? "Tous les mouvements du joueur, sans borne de deal" : periodRangeLabel(period)}
        weeks={[]}
        basePath={`/players/${playerId}`}
        only={["7d", "30d", "lifetime", "custom"]}
        dayGranularCustom
        onSelect={setFilterKey}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600 }}>Type</span>
          {TYPES.map(t => <Chip key={t.key} active={type === t.key} onClick={() => setType(t.key)}>{t.label}</Chip>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600 }}>Statut</span>
          {STATUSES.map(s => <Chip key={s.key} active={status === s.key} onClick={() => setStatus(s.key)}>{s.label}</Chip>)}
        </div>
      </div>

      {/* ── Totaux — suivent les filtres ──────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12,
        border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px", marginBottom: 14,
      }}>
        <div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Lignes</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
            {totals.counted}
            {totals.excluded > 0 && (
              <span style={{ fontSize: 11, fontWeight: 400, color: "#F59E0B" }}> + {totals.excluded} hors totaux</span>
            )}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Dépôts</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmt(totals.deposited)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Retraits</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmt(totals.withdrawn)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Net (retraits − dépôts)</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: totals.net >= 0 ? "var(--green)" : "#EF4444" }}>
            {totals.net >= 0 ? "+" : ""}{fmt(totals.net)} {totals.currencies.length === 1 ? totals.currencies[0] : ""}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 12 }}>
        Signe des lignes au sens agence — dépôt <span style={{ color: "var(--green)" }}>+</span> (entre),
        retrait <span style={{ color: "#f87171" }}>−</span> (sort), comme le tableau Transactions ci-dessus.
        Le net, lui, est le P&amp;L joueur (retraits − dépôts), comme la carte « Net P&amp;L joueur ».
      </div>

      {totals.currencies.length > 1 && (
        <div style={{ fontSize: 11, color: "#F59E0B", marginBottom: 12 }}>
          ⚠️ La sélection mélange {totals.currencies.join(", ")} — les totaux ci-dessus additionnent des devises différentes sans conversion. Filtre par jeu pour une lecture juste.
        </div>
      )}

      {showGap && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12, lineHeight: 1.5 }}>
          Le net lifetime ci-dessus ({lifetimeNet >= 0 ? "+" : ""}{fmt(lifetimeNet)}) diffère de {fmt(Math.abs(gap))} USDT
          du « Net P&L joueur » des cartes plus haut ({dealBoundedNet! >= 0 ? "+" : ""}{fmt(dealBoundedNet!)}).
          Ce n&apos;est pas une incohérence : les cartes ne comptent que les mouvements tombant dans la fenêtre
          du deal de leur game, cet historique montre <b>tout</b>, y compris l&apos;avant-deal.
        </div>
      )}

      {/* ── Tableau ──────────────────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
          {transactions.length === 0 ? "Aucun mouvement pour ce joueur." : "Aucun mouvement ne correspond à ces filtres."}
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {["Date (UTC)", "Jeu", "Type", "Montant", "Source", "Statut", "Contrepartie"].map(h => (
                  <th key={h} style={{ textAlign: h === "Montant" ? "right" : "left", padding: "8px 10px", borderBottom: "1px solid var(--border)", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(tx => {
                const badge = statusBadge(tx);
                const dimmed = !isCountable(tx);
                return (
                  <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)", opacity: dimmed ? 0.6 : 1 }}>
                    <td style={{ padding: "8px 10px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {(tx.tx_at ?? "").slice(0, 19).replace("T", " ").replace("Z", "")}
                    </td>
                    <td style={{ padding: "8px 10px", color: "var(--text-muted)" }}>{tx.game_name ?? "—"}</td>
                    <td style={{ padding: "8px 10px", fontWeight: 600, color: tx.type === "deposit" ? "var(--green)" : "#f87171" }}>
                      {tx.type === "deposit" ? "Dépôt" : "Retrait"}
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap", color: tx.type === "deposit" ? "var(--green)" : "#f87171" }}>
                      {tx.type === "deposit" ? "+" : "−"}{fmt(tx.amount)} {tx.currency}
                    </td>
                    <td style={{ padding: "8px 10px", color: "var(--text-dim)" }}>{sourceLabel(tx.source)}</td>
                    <td style={{ padding: "8px 10px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: badge.color, background: badge.bg, whiteSpace: "nowrap" }}>
                        {badge.label}
                      </span>
                      {tx.settlement_id && (
                        <Link href={`/payments?player=${playerId}#settlement-${tx.settlement_id}`} style={{ marginLeft: 6, fontSize: 10, color: "var(--green)", textDecoration: "none" }}>
                          #{tx.settlement_id} →
                        </Link>
                      )}
                    </td>
                    <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 10, color: "var(--text-dim)" }}>
                      {tx.counterparty_address
                        ? <span title={tx.counterparty_address}>{tx.counterparty_address.slice(0, 8)}…{tx.counterparty_address.slice(-6)}</span>
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
