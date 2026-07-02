/**
 * Display-boundary formatters for ledger amounts (invariant #9: rounding at
 * display only, never inside aggregations).
 *
 * PARITY CONSTRAINT — these are byte-identical copies of the private
 * fmt/fmtKpi in app/akpoker/pnl/TELEClient.tsx. A game migrated onto
 * LedgerShell must render the exact same strings as its TELEClient version;
 * the TELEClient copies get deleted at the final cleanup step once no page
 * uses them anymore.
 */

/** Row-level amount: "+1 234,56" / "−1 234,56" (fr-FR, U+2212 minus). */
export function fmtSignedAmount(n: number): string {
  const abs = Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n >= 0 ? "+" : "−") + abs;
}

/** KPI-card amount: "982.50" / "1.2k" / "−1.2k" (U+2212 minus). */
export function fmtKpiAmount(n: number): string {
  const abs = Math.abs(n);
  return (n < 0 ? "−" : "") + (abs >= 1000 ? (abs / 1000).toFixed(1) + "k" : abs.toFixed(2));
}
