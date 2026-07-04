import { HandCoins, Scale, Users, PiggyBank, Coins } from "lucide-react";
import { getDb } from "@/lib/db";
import {
  getQqpkStakingOverview,
  getQqpkBlockHistory,
  getQqpkGraphData,
  getWalletMeresForGame,
  getPlayerCashouts,
  getPlayerGameWallets,
  type QqpkStakingRow,
  type QqpkGraphData,
  type WalletMere,
} from "@/lib/queries";
import { fmtKpiAmount } from "@/components/ledger/format";
import type { LedgerChart, LedgerGameConfig, LedgerKpiCard, LedgerPeriod } from "@/components/ledger/types";
import type { WalletAddr } from "@/components/ledger/extras/PlayerWalletsPanel";

/**
 * QQPK ledger loader — server-side, builds LedgerShell props from the staking
 * engine outputs. ZERO new money math (rule for this migration): every number
 * (net, C, T, règlement, Part Cercle) is an output of lib/qqpk-staking-engine.ts
 * via getQqpkStakingOverview / getQqpkBlockHistory in lib/queries.ts.
 * "Part Cercle" per player IS the engine's operator_pnl (= −règlement, frozen
 * sign helper operatorPnlFromReglement) — this loader only Σ-sums rows for the
 * KPI card (trivial sum of existing outputs, done server-side).
 *
 * CYCLE FILTER — cycles are ROLLING PER PLAYER (anchored on onboarding), so
 * there is no global cycle timeline. The selector is therefore RELATIVE:
 *   view 0  = "Cycle courant"  → each player's active cycle (overview rows)
 *   view n  = "Cycle −n"       → each player's n-th most recent SETTLED cycle
 *              (players with fewer settled cycles are absent from that view).
 */

export type QqpkHistoryRow = QqpkStakingRow & { settled_at: string | null };

export interface QqpkLedgerData {
  config: LedgerGameConfig;
  kpiCards: LedgerKpiCard[];
  period: LedgerPeriod;
  chart: LedgerChart;
  walletMeres: WalletMere[];
  gameId: number;
  /** 0 = current cycle, n>0 = each player's n-th most recent settled cycle. */
  cycleView: number;
  /** How many past views are available (max settled cycles over all players). */
  maxPastCycles: number;
  /** Rows of the SELECTED view (engine outputs, untouched). */
  rows: QqpkStakingRow[];
  /** All settled cycles, newest first (history table). */
  history: QqpkHistoryRow[];
  cashoutsByPlayer: Record<number, WalletAddr[]>;
  gameWalletsByPlayer: Record<number, WalletAddr[]>;
  /** Séries datées du graph d'évolution (display-only, jamais lu par le lock). */
  graph: QqpkGraphData;
  /** Vérité du graph : dernier point vue cycle (tous joueurs) DOIT == ce KPI. */
  totalCercleKpi: number;
}

export function loadQqpkLedger(params: { cycle?: string }): QqpkLedgerData {
  const basePath = "/qqpk/pnl";
  const requested = parseInt(params.cycle ?? "0", 10);
  const { rows: currentRows } = getQqpkStakingOverview();
  const history = getQqpkBlockHistory() as QqpkHistoryRow[];

  // Settled cycles grouped per player, newest first (history is already
  // ORDER BY block_month DESC — re-sort defensively per player).
  const settledByPlayer = new Map<number, QqpkHistoryRow[]>();
  for (const h of history) {
    const list = settledByPlayer.get(h.player_id) ?? [];
    list.push(h);
    settledByPlayer.set(h.player_id, list);
  }
  for (const list of settledByPlayer.values()) list.sort((a, b) => b.cycle_start.localeCompare(a.cycle_start));
  const maxPastCycles = Math.max(0, ...[...settledByPlayer.values()].map((l) => l.length));

  const cycleView = Number.isInteger(requested) && requested > 0 && requested <= maxPastCycles ? requested : 0;
  const rows: QqpkStakingRow[] = cycleView === 0
    ? currentRows
    : [...settledByPlayer.entries()]
        .map(([, list]) => list[cycleView - 1])
        .filter((r): r is QqpkHistoryRow => r !== undefined)
        .sort((a, b) => a.player_name.localeCompare(b.player_name, "fr", { sensitivity: "base" }));

  // KPI sums — trivial Σ of engine outputs (operator_pnl_projected / t / due flags).
  // Part Cercle KPI = Σ PRÉVISIONNELS (as-if-covered, pertes <30k incluses) — decision
  // Baki: the header must show real exposure. On past views projected == settled real.
  const partCercleTotal = rows.reduce((s, r) => s + r.operator_pnl_projected, 0);
  // RB manuel = Σ qqpk_cycle_rakeback of the displayed view — owner-only room revenue,
  // hors deal, NEVER in the engine/settlement. Shown as its own card + a combined total
  // so Baki never double-counts: three figures, three explicit labels.
  const rbManuelTotal = rows.reduce((s, r) => s + (r.rb_manual ?? 0), 0);
  const totalCercle = partCercleTotal + rbManuelTotal;
  const nbDue = currentRows.filter((r) => r.due).length;
  const makeupEnCours = currentRows.filter((r) => r.t > 0).reduce((s, r) => s + r.t, 0);

  const partAccent: "gold" | "red" = partCercleTotal >= 0 ? "gold" : "red";
  const cycleTag = cycleView === 0 ? "cycle courant" : `cycle −${cycleView}`;
  const kpiCards: LedgerKpiCard[] = [
    {
      label: cycleView === 0 ? "Part Cercle prévisionnelle (cycle courant)" : `Part Cercle (cycle −${cycleView})`,
      value: (partCercleTotal >= 0 ? "+" : "−") + fmtKpiAmount(Math.abs(partCercleTotal)) + " USDT",
      sub: cycleView === 0
        ? "Σ prévisionnels · 30% win / −70% perte, <30k inclus (conditionnel)"
        : "−Σ règlements · 70/30, RB inclus dans le net",
      accent: partAccent,
      icon: <HandCoins size={18} />,
      emphasis: true,
    },
    {
      label: `RB manuel (${cycleTag})`,
      value: "+" + fmtKpiAmount(rbManuelTotal) + " USDT",
      sub: "Σ rakeback room saisi à la main — hors deal, invisible joueur",
      accent: "neutral",
      icon: <Coins size={18} />,
    },
    {
      label: `Total Cercle (prév. + RB) — ${cycleTag}`,
      value: (totalCercle >= 0 ? "+" : "−") + fmtKpiAmount(Math.abs(totalCercle)) + " USDT",
      sub: "Part Cercle + RB manuel — les deux cartes de gauche, rien d'autre",
      accent: totalCercle >= 0 ? "gold" : "red",
      icon: <HandCoins size={18} />,
      emphasis: true,
    },
    ...(cycleView === 0
      ? [
          { label: "Cycles à régler", value: String(nbDue), sub: "Joueurs dont le cycle est échu", accent: (nbDue > 0 ? "gold" : "neutral") as "gold" | "neutral", icon: <Scale size={18} /> },
          { label: "Makeup en cours", value: fmtKpiAmount(makeupEnCours) + " USDT", sub: "Σ T (>0) — couverture Cercle projetée", accent: "neutral" as const, icon: <PiggyBank size={18} /> },
        ]
      : [
          { label: "Cycles affichés", value: String(rows.length), sub: `${cycleView}ᵉ cycle réglé le plus récent par joueur`, accent: "neutral" as const, icon: <Scale size={18} /> },
        ]),
    { label: "Joueurs QQPK", value: String(currentRows.length), sub: "Joueurs avec un cycle QQPK", accent: "neutral", icon: <Users size={18} /> },
  ];

  const gameId = (getDb().prepare(`SELECT id FROM games WHERE name = 'QQPK'`).get() as { id: number } | undefined)?.id ?? 0;
  const walletMeres = gameId ? getWalletMeresForGame(gameId) : [];

  const cashoutsByPlayer: Record<number, WalletAddr[]> = {};
  const gameWalletsByPlayer: Record<number, WalletAddr[]> = {};
  for (const r of currentRows) {
    cashoutsByPlayer[r.player_id] = gameId ? (getPlayerCashouts(r.player_id, gameId) as WalletAddr[]) : [];
    gameWalletsByPlayer[r.player_id] = gameId ? (getPlayerGameWallets(r.player_id, gameId) as WalletAddr[]) : [];
  }

  return {
    config: {
      title: "QQPK — Staking",
      subtitle: "Cycle roulant par joueur (onboarding +1 mois) · reset sec · 70/30 (rakeback inclus dans le net)",
      basePath,
    },
    kpiCards,
    // periodContent (cycle selector) replaces the bar — supported:false is the fallback.
    period: { supported: false, notApplicableReason: "Cycle mensuel roulant par joueur — pas de granularité jour" },
    chart: { supported: false },
    walletMeres,
    gameId,
    cycleView,
    maxPastCycles,
    rows,
    history,
    cashoutsByPlayer,
    gameWalletsByPlayer,
    graph: getQqpkGraphData(cycleView),
    totalCercleKpi: totalCercle,
  };
}
