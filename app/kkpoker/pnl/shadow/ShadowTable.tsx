"use client";

import { Fragment, useMemo, useState } from "react";
import { fmtSignedAmount } from "@/components/ledger/format";
import PlayerWalletsPanel, { WalletBadgeButton, type WalletAddr } from "@/components/ledger/extras/PlayerWalletsPanel";
import SettlementFlow, { dueLabel, type AvailableTx, type SettlementRow, type SettlementPreview } from "@/components/ledger/extras/SettlementFlow";
import Btn from "@/components/Btn";
import { Scale, Search, ChevronDown, ChevronUp } from "lucide-react";
import type { KkLedgerRow } from "@/lib/games/kkpoker/ledger";

/**
 * KKPOKER shadow table — TELEClient's KK columns (parity on the numbers) plus
 * the two ledger extras plugged in A5-style: 💼 wallet badge next to the name
 * (opens PlayerWalletsPanel read-only) and a "Régler" button per row (opens
 * SettlementFlow with preview only — no lock/pay/unlock actions wired).
 *
 * Search + sort are display-only (filter/reorder the server-computed rows);
 * the estimated due badge shows the loader's previewSettlement result — no
 * client-side money math.
 */

type SortKey = "name" | "net" | "my_pnl" | "due";

export default function ShadowTable({
  rows, gameId, cashoutsByPlayer, gameWalletsByPlayer, availableByPlayer, settlementsByPlayer, estimatedDueByPlayer, previewAction,
  showSettlementPreview = true,
}: {
  rows: KkLedgerRow[];
  gameId: number;
  cashoutsByPlayer: Record<number, WalletAddr[]>;
  gameWalletsByPlayer: Record<number, WalletAddr[]>;
  availableByPlayer: Record<number, AvailableTx[]>;
  settlementsByPlayer: Record<number, SettlementRow[]>;
  estimatedDueByPlayer: Record<number, number>;
  previewAction: (playerId: number, txIds: number[]) => Promise<SettlementPreview>;
  /**
   * Settlement preview IN THE TABLE ("N à régler" pills + "≈ due" per row).
   * false → hidden (KK: wallet-based continuous flow, a permanent estimated
   * due is noise); the amounts still show inside the SettlementFlow panel
   * (the real settlement moment). true (default) → current behavior, for
   * games where settlement is a real cycle (QQPK monthly, A5).
   */
  showSettlementPreview?: boolean;
}) {
  const [walletOpen, setWalletOpen] = useState<number | null>(null);
  const [settleOpen, setSettleOpen] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("my_pnl");
  const [sortDir, setSortDir] = useState<1 | -1>(-1); // -1 = desc (default, matches prod my_pnl desc)

  function toggleSort(key: SortKey) {
    if (sortKey === key) { setSortDir(d => (d === 1 ? -1 : 1)); }
    else { setSortKey(key); setSortDir(key === "name" ? 1 : -1); }
  }

  const displayed = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter(r => r.player_name.toLowerCase().includes(q)) : rows;
    const val = (r: KkLedgerRow): number | string => {
      if (sortKey === "name") return r.player_name.toLowerCase();
      if (sortKey === "net") return r.net;
      if (sortKey === "due") return estimatedDueByPlayer[r.player_id] ?? 0;
      return r.my_pnl;
    };
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * sortDir;
    });
  }, [rows, search, sortKey, sortDir, estimatedDueByPlayer]);

  const COLS = 7;
  const nbToSettle = rows.filter(r => (availableByPlayer[r.player_id]?.length ?? 0) > 0).length;
  const nbLocked = Object.values(settlementsByPlayer).flat().filter(s => s.status === "locked").length;

  const sortIndicator = (key: SortKey) => sortKey === key
    ? (sortDir === -1 ? <ChevronDown size={11} style={{ verticalAlign: "-2px" }} /> : <ChevronUp size={11} style={{ verticalAlign: "-2px" }} />)
    : null;
  const sortableTh = (label: string, key: SortKey, align: "left" | "center" = "left") => (
    <th style={{ padding: 0, textAlign: align }}>
      <button onClick={() => toggleSort(key)} style={{ width: "100%", padding: "10px 16px", textAlign: align, fontSize: 11, fontWeight: 600, color: sortKey === key ? "var(--text)" : "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap", background: "transparent", border: "none", cursor: "pointer" }}>
        {label} {sortIndicator(key)}
      </button>
    </th>
  );

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 28 }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Joueurs KKPOKER</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>shadow — settlement en preview seul</span>
        {showSettlementPreview && nbToSettle > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: "#F5C518", background: "rgba(245,197,24,0.12)", border: "1px solid rgba(245,197,24,0.3)", padding: "2px 8px", borderRadius: 10 }}>{nbToSettle} à régler</span>}
        {nbLocked > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: "#10B981", background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", padding: "2px 8px", borderRadius: 10 }}>{nbLocked} à payer</span>}
        <div style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 7, padding: "5px 10px" }}>
          <Search size={12} color="var(--text-dim)" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Chercher un joueur…"
            spellCheck={false}
            style={{ background: "transparent", border: "none", outline: "none", fontSize: 12, color: "var(--text)", width: 160 }}
          />
          {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11, padding: 0 }}>✕</button>}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {sortableTh("Joueur", "name")}
              {sortableTh("Net P&L", "net")}
              {sortableTh("Agency P&L", "my_pnl")}
              {["Action %", "RB %", "Début"].map((h, i) => (
                <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
              ))}
              {sortableTh("Règlement", "due", "center")}
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 ? (
              <tr><td colSpan={COLS} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                {search ? `Aucun joueur ne correspond à « ${search} »` : "Aucun joueur KKPOKER — ajoute un deal à un joueur depuis son profil"}
              </td></tr>
            ) : displayed.map(row => {
              const netC = row.net > 0 ? "var(--green)" : row.net < 0 ? "#f87171" : "rgba(255,255,255,0.15)";
              const myC = row.my_pnl > 0 ? "var(--green)" : row.my_pnl < 0 ? "#f87171" : "rgba(255,255,255,0.15)";
              const gw = gameWalletsByPlayer[row.player_id] ?? [];
              const co = cashoutsByPlayer[row.player_id] ?? [];
              const walletCount = gw.length + co.length;
              const avail = availableByPlayer[row.player_id] ?? [];
              const pSettlements = settlementsByPlayer[row.player_id] ?? [];
              const lockedN = pSettlements.filter(s => s.status === "locked").length;
              const isWalletOpen = walletOpen === row.player_id;
              const isSettleOpen = settleOpen === row.player_id;
              const rowOpen = isWalletOpen || isSettleOpen;
              return (
                <Fragment key={row.player_id}>
                  <tr style={{ borderBottom: rowOpen ? "none" : "1px solid var(--border)", background: avail.length > 0 ? "rgba(245,197,24,0.04)" : undefined }}>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                        <WalletBadgeButton count={walletCount} isOpen={isWalletOpen} onClick={() => { setSettleOpen(null); setWalletOpen(isWalletOpen ? null : row.player_id); }} />
                        <span>{row.player_name}</span>
                        {showSettlementPreview && avail.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#F5C518", background: "rgba(245,197,24,0.12)", border: "1px solid rgba(245,197,24,0.3)", padding: "1px 7px", borderRadius: 10 }}>{avail.length} à régler</span>}
                        {showSettlementPreview && estimatedDueByPlayer[row.player_id] !== undefined && (
                          // Estimated due over ALL unsettled tx — value straight from
                          // previewSettlement (loader), same number as the Régler recap.
                          <span
                            title={`${dueLabel(estimatedDueByPlayer[row.player_id]).hint} — estimation sur TOUTES les tx non réglées (le flow Régler ne pré-coche que la dernière semaine, « Tout cocher » pour retrouver ce montant)`}
                            style={{ fontSize: 10, fontWeight: 700, color: dueLabel(estimatedDueByPlayer[row.player_id]).color, whiteSpace: "nowrap", cursor: "help" }}>
                            ≈ {dueLabel(estimatedDueByPlayer[row.player_id]).text}
                          </span>
                        )}
                        {lockedN > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: "#10B981", background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", padding: "1px 7px", borderRadius: 10 }}>{lockedN} à payer</span>}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: netC }}>{row.net === 0 ? "—" : fmtSignedAmount(row.net)}</td>
                    <td style={{ padding: "12px 16px", fontSize: 14, fontWeight: 700, color: myC }}>{row.my_pnl === 0 ? "—" : fmtSignedAmount(row.my_pnl)}</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "var(--gold)" }}>{row.action_pct}%</td>
                    <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "#38bdf8" }}>{row.rakeback_pct}%</td>
                    <td style={{ padding: "12px 16px", fontSize: 12, fontWeight: 600, color: row.start_date ? "var(--text)" : "var(--text-dim)" }}>{row.start_date ?? "—"}</td>
                    <td style={{ padding: "12px 16px", textAlign: "center" }}>
                      <Btn variant={isSettleOpen ? "secondary" : "primary"} onClick={() => { setWalletOpen(null); setSettleOpen(isSettleOpen ? null : row.player_id); }} style={{ fontSize: 11, gap: 5, padding: "6px 12px" }}>
                        <Scale size={13} /> {isSettleOpen ? "Fermer" : "Régler"}
                      </Btn>
                    </td>
                  </tr>
                  {isWalletOpen && (
                    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                      <td colSpan={COLS} style={{ padding: "16px 20px" }}>
                        <PlayerWalletsPanel
                          playerId={row.player_id}
                          gameId={gameId}
                          gameLabel="KKPOKER"
                          gameWallets={gw}
                          cashouts={co}
                          readOnly
                          onClose={() => setWalletOpen(null)}
                        />
                      </td>
                    </tr>
                  )}
                  {isSettleOpen && (
                    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                      <td colSpan={COLS} style={{ padding: "16px 20px" }}>
                        <SettlementFlow
                          playerId={row.player_id}
                          playerName={row.player_name}
                          avail={avail}
                          settlements={pSettlements}
                          previewAction={previewAction}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
