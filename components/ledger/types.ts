import type { ReactNode } from "react";

/**
 * Contracts for the generic P&L ledger shell.
 *
 * DESIGN INVARIANT — the shell is money-blind.
 * Every amount reaches the shell ALREADY formatted as a display string,
 * computed by each game's server-side loader via the existing query
 * functions (getLockAwareKPIsWithExtras, getWalletSummaryByPlayer,
 * manual-settlement-engine, getQqpkStakingOverview, …). The shell performs
 * NO arithmetic, NO aggregation, NO currency conversion. This keeps money
 * math in lib/queries.ts (invariant #2) and rounding at the display boundary
 * only (invariant #9). Migrating a game to the shell must not touch its math.
 *
 * The shell also knows nothing about individual games: each game declares its
 * config + data (via a loader) + which optional extras it plugs in.
 */

/** One KPI/total card. `value`/`sub` are pre-formatted display strings. */
export interface LedgerKpiCard {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: "green" | "gold" | "neutral" | "red";
  icon?: ReactNode;
  /** Slightly wider column in the KPI grid (visual priority — e.g. Mon Total P&L). */
  emphasis?: boolean;
}

/**
 * Period-filter descriptor.
 * - supported:true  → render the shared <PeriodFilterBar/>.
 * - supported:false → render a muted "Non applicable" placeholder (e.g. QQPK's
 *   monthly staking cycle has no day-granular period). The bar is DISPLAYED as
 *   non-applicable, never silently removed.
 */
export interface LedgerPeriod {
  supported: boolean;
  activeFilter?: string;
  rangeLabel?: string;
  weeks?: { isoWeek: string; label: string }[];
  basePath?: string;
  /** Shown inside the "Non applicable" placeholder when supported:false. */
  notApplicableReason?: string;
}

/**
 * Net P&L evolution chart descriptor.
 * - supported:false → chart omitted (e.g. games with no day-granular series).
 */
export interface LedgerChart {
  supported: boolean;
  series?: { day: string; cumulative_net: number }[];
  cardNet?: number;
  currency?: string;
  rangeLabel?: string;
}

/** Static, game-declared identity/config. No data, no math. */
export interface LedgerGameConfig {
  title: string;
  subtitle?: string;
  /** e.g. "/kkpoker/pnl" — used by PeriodFilterBar navigation. */
  basePath: string;
}

/** Props for the generic shell. `children` = the game's table + settlement/staking extras. */
export interface LedgerShellProps {
  config: LedgerGameConfig;
  kpiCards: LedgerKpiCard[];
  period: LedgerPeriod;
  chart?: LedgerChart;
  /** Header right-slot (e.g. player-filter chip / global actions). */
  headerAction?: ReactNode;
  /** Action bar under the header (Sync Wallets / Config Wallets …). */
  actions?: ReactNode;
  /** Wallet-mère banner (game-provided markup for now). */
  walletMeresBanner?: ReactNode;
  /** Table + settlement/staking extras — rendered below the chart. */
  children?: ReactNode;
}
