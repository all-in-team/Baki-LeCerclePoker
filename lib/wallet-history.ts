import type { PlayersPeriod } from "@/app/players/shared";

// ─── HISTORIQUE DES MOUVEMENTS D'UN JOUEUR ────────────────────────────────────
//
// Module PUR : aucun import de ./db. C'est délibéré — la règle « quelle ligne
// compte dans un total » doit être écrite UNE fois et exécutée des deux côtés,
// par le SQL au serveur et par le filtrage à l'écran. Deux copies auraient
// dérivé, et une colonne de total fausse est pire qu'une colonne absente.
//
// Ce que cette vue montre, et qui la distingue des cartes P&L de la fiche :
// TOUS les mouvements du joueur, y compris ceux ANTÉRIEURS à son deal. Les
// cartes P&L, elles, bornent chaque mouvement à `pgd.start_date`/`end_date`.
// Sur 9 joueurs de la base l'écart est réel (jusqu'à ~22 000 USDT sur le plus
// ancien) : ce n'est pas une erreur, ce sont deux questions différentes.
// L'écran l'annonce au lieu de laisser croire à une contradiction.
//
// ─────────────────────────────────────────────────────────────────────────────

export type HistoryTx = {
  id: number;
  tx_at: string;                       // tx_datetime, ou tx_date si absent
  game_name: string | null;
  type: "deposit" | "withdrawal";
  amount: number;
  currency: string;
  source: string | null;               // 'sync' | 'manual' | 'unknown' (legacy)
  status: string | null;               // 'active' | 'quarantined' | 'rejected'
  settled: number;
  settlement_id: number | null;
  settlement_status: string | null;    // 'locked' | 'paid'
  settlement_kind: string | null;
  settlement_paid_at: string | null;
  settlement_amount_due: number | null;
  counterparty_address: string | null;
  tron_tx_hash: string | null;
  note: string | null;
  created_at: string;
};

/**
 * LA règle de comptage, miroir exact du prédicat SQL utilisé partout dans le
 * repo : `(source IS NULL OR source != 'unknown') AND (status IS NULL OR status = 'active')`.
 *
 * Fail-closed sur le statut : tout état autre qu'`active` est exclu, y compris
 * un état futur qu'on n'aurait pas encore prévu. Une ligne non comptée reste
 * VISIBLE dans le tableau, avec son badge — on ne cache rien, on ne compte pas.
 */
export function isCountable(tx: Pick<HistoryTx, "source" | "status">): boolean {
  const sourceOk = tx.source == null || tx.source !== "unknown";
  const statusOk = tx.status == null || tx.status === "active";
  return sourceOk && statusOk;
}

export type TxTypeFilter = "all" | "deposit" | "withdrawal";
export type TxStatusFilter = "all" | "settled" | "unsettled" | "quarantined";

export function matchesType(tx: HistoryTx, f: TxTypeFilter): boolean {
  return f === "all" || tx.type === f;
}

export function matchesStatus(tx: HistoryTx, f: TxStatusFilter): boolean {
  switch (f) {
    case "all": return true;
    // « Non comptée » couvre quarantaine ET rejet : les deux sont hors des
    // totaux, et c'est ce que Baki cherche quand il filtre là-dessus.
    case "quarantined": return !isCountable(tx);
    // Réglée / non réglée ne s'appliquent qu'aux lignes qui comptent : une ligne
    // en quarantaine n'est ni l'une ni l'autre, elle attend un arbitrage.
    case "settled": return isCountable(tx) && tx.settled === 1;
    case "unsettled": return isCountable(tx) && tx.settled !== 1;
  }
}

/**
 * Fenêtre de période, en journées UTC — même convention que la page Joueurs
 * (cf. la réserve documentée sur PlayersPeriod : `from + T00:00:00Z` /
 * `to + T23:59:59Z`, comparés à `tx_datetime` qui est stocké en UTC).
 */
export function matchesPeriod(tx: HistoryTx, period: PlayersPeriod): boolean {
  if (period.kind === "lifetime") return true;
  const at = tx.tx_at;
  if (!at) return false;
  if (period.from && at < `${period.from}T00:00:00Z`) return false;
  if (period.to && at > `${period.to}T23:59:59Z`) return false;
  return true;
}

export function filterHistory(
  rows: HistoryTx[],
  period: PlayersPeriod,
  type: TxTypeFilter,
  status: TxStatusFilter,
): HistoryTx[] {
  return rows.filter(tx => matchesPeriod(tx, period) && matchesType(tx, type) && matchesStatus(tx, status));
}

export type HistoryTotals = {
  /** Lignes affichées, toutes confondues. */
  rows: number;
  /** Lignes réellement sommées (isCountable). */
  counted: number;
  /** Lignes visibles mais exclues des totaux (quarantaine, rejet, legacy 'unknown'). */
  excluded: number;
  deposited: number;
  withdrawn: number;
  /** Point de vue joueur : retraits − dépôts, comme partout dans le repo. */
  net: number;
};

/**
 * Totaux de la vue filtrée. Ne somme QUE les lignes comptables.
 *
 * Invariant #3 du repo : on ne somme jamais des devises différentes sans
 * toUsdt(). Ici on ne convertit pas — on somme par devise et on signale si le
 * lot en mélange plusieurs, plutôt que d'additionner des pommes et des poires.
 */
export function computeTotals(rows: HistoryTx[]): HistoryTotals & { currencies: string[] } {
  let deposited = 0, withdrawn = 0, counted = 0;
  const currencies = new Set<string>();
  for (const tx of rows) {
    if (!isCountable(tx)) continue;
    counted++;
    currencies.add(tx.currency);
    if (tx.type === "deposit") deposited += tx.amount;
    else withdrawn += tx.amount;
  }
  return {
    rows: rows.length,
    counted,
    excluded: rows.length - counted,
    deposited,
    withdrawn,
    net: withdrawn - deposited,
    currencies: [...currencies].sort(),
  };
}

/** Libellé du badge de statut, et sa couleur. */
export function statusBadge(tx: HistoryTx): { label: string; color: string; bg: string } {
  if (tx.status === "quarantined") return { label: "quarantaine", color: "#F59E0B", bg: "rgba(245,158,11,0.12)" };
  if (tx.status === "rejected") return { label: "rejetée", color: "#9CA3AF", bg: "rgba(156,163,175,0.12)" };
  if (tx.source === "unknown") return { label: "source inconnue", color: "#9CA3AF", bg: "rgba(156,163,175,0.12)" };
  if (tx.settled === 1) {
    const paid = !!tx.settlement_paid_at;
    return paid
      ? { label: `réglée · payé`, color: "#10B981", bg: "rgba(16,185,129,0.12)" }
      : { label: `réglée · à payer`, color: "#3B82F6", bg: "rgba(59,130,246,0.12)" };
  }
  return { label: "non réglée", color: "#D4AF37", bg: "rgba(212,175,55,0.12)" };
}

export function sourceLabel(source: string | null): string {
  if (source === "sync") return "sync on-chain";
  if (source === "manual") return "manuelle";
  return source ?? "—";
}

/**
 * CSV de la vue filtrée. `;` + BOM UTF-8 : s'ouvre directement dans Excel FR
 * sans passer par l'assistant d'import.
 */
export function historyToCsv(rows: HistoryTx[]): string {
  const head = [
    "id", "date", "jeu", "type", "montant", "devise", "source", "statut_ligne",
    "comptee_dans_les_totaux", "reglee", "reglement_id", "reglement_statut",
    "reglement_paye_le", "contrepartie_trc20", "tron_tx_hash", "note", "importee_le",
  ];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(";")];
  for (const tx of rows) {
    lines.push([
      tx.id,
      tx.tx_at,
      tx.game_name ?? "",
      tx.type === "deposit" ? "dépôt" : "retrait",
      // Point décimal : le CSV doit rester relisible par un tableur non-FR.
      tx.amount,
      tx.currency,
      sourceLabel(tx.source),
      tx.status ?? "",
      isCountable(tx) ? "oui" : "non",
      tx.settled === 1 ? "oui" : "non",
      tx.settlement_id ?? "",
      tx.settlement_status ?? "",
      tx.settlement_paid_at ?? "",
      tx.counterparty_address ?? "",
      tx.tron_tx_hash ?? "",
      tx.note ?? "",
      tx.created_at,
    ].map(esc).join(";"));
  }
  return "﻿" + lines.join("\n");
}
