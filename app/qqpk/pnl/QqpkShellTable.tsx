"use client";

import { useEffect, useMemo, useState, Fragment } from "react";
import { useRouter } from "next/navigation";
import { Check, Scale, AlertTriangle, CalendarClock, Search, ChevronDown, ChevronUp, ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react";
import Modal from "@/components/Modal";
import Btn from "@/components/Btn";
import PlayerWalletsPanel, { WalletBadgeButton, type WalletAddr } from "@/components/ledger/extras/PlayerWalletsPanel";
import { dueLabel } from "@/components/ledger/extras/SettlementFlow";
import { saveMainsAction, saveCycleRakebackAction, previewSettlementAction, settleCycleAction } from "./actions";

/**
 * QQPK staking table on LedgerShell — the per-player cycle rows + history +
 * settle recap, carried over from QqpkStakingClient (retired by this swap).
 *
 * ZERO money math here: every number (résultat, C, T, règlement, Part Cercle)
 * comes from the staking engine via the server loader. "Part Cercle" affichée
 * sur le cycle courant IS the engine's operator_pnl_projected (prévisionnel
 * as-if-covered, pertes <30k incluses — projectStakingBlock, = −règlement
 * prévisionnel) ; le panneau Régler affiche le RÉEL du moteur (gate 30k, ce que
 * le lock écrit). This file only formats. Search/sort are display-only. The
 * règlement direction uses the shared dueLabel (signed amount + color +
 * tooltip — no "verse" wording), same convention: >0 = le Cercle paie le joueur.
 */

const PART_CERCLE_PROJ_TOOLTIP =
  "Part Cercle prévisionnelle (30% win / 70% perte) — conditionnelle si <30k mains : sous 30 000 mains en fin de cycle, " +
  "la couverture des pertes est annulée (réglable 0). Calculée sur le net on-chain du cycle (retraits − dépôts, tx manuelles " +
  "comprises) — le rakeback est inclus dans ce total ; l'ajustement RB se fait à la main (transaction manuelle). " +
  "Positif = ça rapporte au Cercle, négatif = ça lui coûte.";

const RB_MANUEL_TOOLTIP =
  "Rakeback perçu par le Cercle sur ce joueur — hors deal, invisible joueur, saisie manuelle. " +
  "Revenu Cercle pur : n'entre JAMAIS dans le 70/30, le règlement ni le lock. Lié au cycle courant " +
  "(nouveau cycle = case vide, l'historique garde sa valeur).";

const PART_CERCLE_SETTLED_TOOLTIP =
  "Part Cercle = −règlement du cycle : le Cercle couvre 70% des pertes / prend 30% des gains (condition 30 000 mains). " +
  "Calculée sur le net on-chain du cycle (retraits − dépôts, tx manuelles comprises) — le rakeback est inclus dans ce total ; " +
  "l'ajustement RB se fait à la main (transaction manuelle). Positif = ça rapporte au Cercle, négatif = ça lui coûte.";

interface Row {
  player_id: number;
  player_name: string;
  start_date: string;
  cycle_start: string;
  cycle_end_incl: string;
  settle_date: string;
  due: boolean;
  days_overdue: number;
  resultat_periode: number;
  mains: number;
  c: number;
  t: number;
  reglement: number;
  condition_30k_applied: boolean;
  operator_pnl: number;
  reglement_projected: number;
  operator_pnl_projected: number;
  /** RB manuel du cycle (owner-only, hors deal) — affichage + saisie, jamais dans le lock. */
  rb_manual?: number;
  settled_at?: string | null;
}

interface Cycle {
  player_start_date: string; cycle_index: number; cycle_start: string;
  cycle_end_incl: string; settle_date: string; start_iso: string; end_iso: string;
  due: boolean; days_overdue: number;
}

/** Dépôt/retrait du cycle — display-only, fourni par le loader (mêmes filtres que le net). */
interface CycleTx {
  id: number;
  tx_datetime: string | null;
  tx_date: string;
  type: "deposit" | "withdrawal";
  amount: number;
  source: string | null;
  tron_tx_hash: string | null;
}

const TRONSCAN_TX = "https://tronscan.org/#/transaction/";
interface Preview {
  ok: boolean; error?: string; player_id: number; cycle?: Cycle;
  resultat_periode?: number; mains?: number; c?: number; t?: number;
  reglement?: number; condition_30k_applied?: boolean; operator_pnl?: number;
  reglement_projected?: number; operator_pnl_projected?: number;
}

function fmt(n: number): string {
  return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(n: number): string {
  return (n >= 0 ? "+" : "−") + fmt(n);
}
function fmtDate(key: string): string {
  if (!key) return "—";
  // Accepte 'YYYY-MM-DD', ISO, et le format SQLite 'YYYY-MM-DD HH:MM:SS' (settled_at).
  const iso = key.includes("T") ? key : key.includes(" ") ? key.replace(" ", "T") + "Z" : key + "T00:00:00Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function partCercleColor(v: number): string {
  if (Math.abs(v) < 0.005) return "var(--text-dim)";
  return v > 0 ? "#10B981" : "#EF4444";
}

function ConditionBadge({ row }: { row: { mains: number; condition_30k_applied: boolean } }) {
  if (row.condition_30k_applied) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(239,68,68,0.15)", color: "#EF4444", whiteSpace: "nowrap" }}>⚠️ &lt;30k — non couvert</span>;
  }
  if (row.mains >= 30000) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(16,185,129,0.15)", color: "#10B981", whiteSpace: "nowrap" }}>✓ 30k OK</span>;
  }
  return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(245,197,24,0.15)", color: "#F5C518", whiteSpace: "nowrap" }}>&lt;30k</span>;
}

function StatusBadge({ due, days_overdue }: { due: boolean; days_overdue: number }) {
  if (due && days_overdue > 0) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(239,68,68,0.15)", color: "#EF4444", whiteSpace: "nowrap" }}>En retard ({days_overdue}j)</span>;
  }
  if (due) {
    return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(245,197,24,0.15)", color: "#F5C518", whiteSpace: "nowrap" }}>À régler</span>;
  }
  return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: "rgba(136,136,160,0.15)", color: "var(--text-muted)", whiteSpace: "nowrap" }}>En cours</span>;
}

function ReglementCell({ reglement }: { reglement: number }) {
  const reg = dueLabel(reglement);
  return (
    <span title={reg.hint} style={{ fontSize: 12, fontWeight: 600, color: reg.color, whiteSpace: "nowrap", cursor: "help" }}>
      {reg.text}
    </span>
  );
}

function RbValue({ amount }: { amount: number }) {
  if (amount > 0.005) return <span style={{ fontWeight: 600, color: "#F5C518" }}>+{fmt(amount)}</span>;
  return <span style={{ color: "var(--text-dim)" }}>—</span>;
}

type SortKey = "name" | "resultat" | "part";

export default function QqpkShellTable({
  rows, history, gameId, cycleView, cashoutsByPlayer = {}, gameWalletsByPlayer = {}, transactionsByPlayer = {}, loadedAt,
}: {
  rows: Row[];
  history: Row[];
  gameId: number;
  /** 0 = cycle courant (éditable/réglable), n>0 = n-ième cycle réglé (lecture seule). */
  cycleView: number;
  cashoutsByPlayer?: Record<number, WalletAddr[]>;
  gameWalletsByPlayer?: Record<number, WalletAddr[]>;
  /** Dépôts/retraits du cycle affiché, par joueur — Σ liste == Résultat (garanti côté loader). */
  transactionsByPlayer?: Record<number, CycleTx[]>;
  /** ISO du rendu serveur — affiché en header, rafraîchi par le refresh au focus. */
  loadedAt?: string;
}) {
  const router = useRouter();
  const isCurrent = cycleView === 0;
  const [mainsEdits, setMainsEdits] = useState<Record<number, string>>({});
  const [rbEditing, setRbEditing] = useState<number | null>(null);
  const [rbDraft, setRbDraft] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [recap, setRecap] = useState<{ player: Row; preview: Preview } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [expandedWallet, setExpandedWallet] = useState<number | null>(null);
  const [expandedTx, setExpandedTx] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1); // name asc par défaut (ordre historique de la page)

  // Fraîcheur : un onglet laissé ouvert des jours affichait un état périmé face au
  // modal Régler (toujours frais via server action). Retour de focus → refresh serveur.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") router.refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) { setSortDir((d) => (d === 1 ? -1 : 1)); }
    else { setSortKey(key); setSortDir(key === "name" ? 1 : -1); }
  }

  const displayed = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.player_name.toLowerCase().includes(q)) : rows;
    const val = (r: Row): number | string => {
      if (sortKey === "name") return r.player_name.toLowerCase();
      if (sortKey === "resultat") return r.resultat_periode;
      return r.operator_pnl_projected;
    };
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * sortDir;
    });
  }, [rows, search, sortKey, sortDir]);

  async function saveMains(pid: number) {
    const raw = mainsEdits[pid];
    if (raw === undefined) return;
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) { alert("Mains: entier ≥ 0 requis."); return; }
    setBusy(pid);
    try {
      const res = await saveMainsAction(pid, n);
      if (!res.ok) { alert(res.error ?? "Erreur"); return; }
      setMainsEdits((m) => { const c = { ...m }; delete c[pid]; return c; });
      router.refresh();
    } finally { setBusy(null); }
  }

  // RB manuel — inline edit (clic → input, Enter = save, Esc = cancel). Affichage/saisie
  // uniquement : le montant part dans qqpk_cycle_rakeback via l'action, jamais dans le lock.
  async function saveRb(pid: number) {
    const n = Number(rbDraft.trim().replace(",", "."));
    if (!Number.isFinite(n) || n < 0) { alert("RB manuel : nombre ≥ 0 requis."); return; }
    setBusy(pid);
    try {
      const res = await saveCycleRakebackAction(pid, n);
      if (!res.ok) { alert(res.error ?? "Erreur"); return; }
      setRbEditing(null);
      router.refresh();
    } finally { setBusy(null); }
  }

  async function openRecap(player: Row) {
    setBusy(player.player_id);
    try {
      const preview = (await previewSettlementAction(player.player_id)) as Preview;
      setRecap({ player, preview });
    } finally { setBusy(null); }
  }

  async function confirmSettle() {
    if (!recap) return;
    setConfirming(true);
    try {
      const res = await settleCycleAction(recap.player.player_id);
      if (!res.ok) { alert(res.error ?? "Erreur règlement"); return; }
      setRecap(null);
      router.refresh();
    } finally { setConfirming(false); }
  }

  const th: React.CSSProperties = { textAlign: "right", padding: "8px 10px", color: "var(--text-muted)", fontWeight: 600, fontSize: 11, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "10px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 12 };
  const COLS = isCurrent ? 13 : 11;
  // Cycle courant → prévisionnel ; vues passées → cycles réglés (projected == réel côté loader).
  const partTooltip = isCurrent ? PART_CERCLE_PROJ_TOOLTIP : PART_CERCLE_SETTLED_TOOLTIP;

  const sortIndicator = (key: SortKey) => sortKey === key
    ? (sortDir === -1 ? <ChevronDown size={11} style={{ verticalAlign: "-2px" }} /> : <ChevronUp size={11} style={{ verticalAlign: "-2px" }} />)
    : null;
  const sortableTh = (label: string, key: SortKey, align: "left" | "right" = "right", title?: string) => (
    <th style={{ padding: 0, textAlign: align }}>
      <button onClick={() => toggleSort(key)} title={title} style={{ width: "100%", padding: "8px 10px", textAlign: align, fontSize: 11, fontWeight: 600, color: sortKey === key ? "var(--text)" : "var(--text-muted)", whiteSpace: "nowrap", background: "transparent", border: "none", cursor: "pointer" }}>
        {label} {sortIndicator(key)}
      </button>
    </th>
  );

  return (
    <>
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            {isCurrent ? "Cycles actifs (roulant par joueur · reset sec)" : `Cycle −${cycleView} — cycles réglés (lecture seule)`}
          </span>
          {loadedAt && (
            <span title="Heure du dernier chargement serveur — la page se rafraîchit automatiquement au retour sur l'onglet" style={{ fontSize: 10, color: "var(--text-dim)", cursor: "help" }}>
              données au {new Date(loadedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 7, padding: "5px 10px" }}>
            <Search size={12} color="var(--text-dim)" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Chercher un joueur…"
              spellCheck={false}
              style={{ background: "transparent", border: "none", outline: "none", fontSize: 12, color: "var(--text)", width: 160 }}
            />
            {search && <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11, padding: 0 }}>✕</button>}
          </span>
        </div>
        {displayed.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
            {search ? `Aucun joueur ne correspond à « ${search} »` : isCurrent ? "Aucun joueur QQPK (pas de deal/onboarding QQPK)." : "Aucun joueur n'a autant de cycles réglés."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: isCurrent ? 1220 : 980 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {sortableTh("Joueur", "name", "left")}
                  <th style={{ ...th, textAlign: "left" }}>Cycle</th>
                  {isCurrent ? (
                    <>
                      <th style={{ ...th, textAlign: "left" }}>Échéance</th>
                      <th style={{ ...th, textAlign: "center" }}>Statut</th>
                    </>
                  ) : (
                    <th style={{ ...th, textAlign: "left" }}>Réglé le</th>
                  )}
                  {sortableTh("Résultat", "resultat")}
                  <th style={th}>Mains</th>
                  <th style={th}>C</th>
                  <th style={th}>T</th>
                  {sortableTh(isCurrent ? "Part Cercle (prév.)" : "Part Cercle", "part", "right", partTooltip)}
                  <th title={RB_MANUEL_TOOLTIP} style={{ ...th, cursor: "help" }}>RB (manuel)</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Règlement</th>
                  <th style={{ ...th, textAlign: "center" }}>30k</th>
                  {isCurrent && <th style={{ ...th, textAlign: "center" }}>Action</th>}
                </tr>
              </thead>
              <tbody>
                {displayed.map((r) => {
                  const edited = mainsEdits[r.player_id] !== undefined && parseInt(mainsEdits[r.player_id] || "0", 10) !== r.mains;
                  const gw = gameWalletsByPlayer[r.player_id] ?? [];
                  const co = cashoutsByPlayer[r.player_id] ?? [];
                  const walletCount = gw.length + co.length;
                  const isWalletOpen = expandedWallet === r.player_id;
                  const txs = transactionsByPlayer[r.player_id] ?? [];
                  const isTxOpen = expandedTx === r.player_id;
                  return (
                    <Fragment key={`${r.player_id}-${r.cycle_start}`}>
                      <tr style={{ borderBottom: isWalletOpen || isTxOpen ? "none" : "1px solid var(--border)", background: isCurrent && r.due ? "rgba(245,197,24,0.04)" : undefined }}>
                        <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                            <WalletBadgeButton count={walletCount} isOpen={isWalletOpen} onClick={() => setExpandedWallet(isWalletOpen ? null : r.player_id)} />
                            <span>{r.player_name}</span>
                          </span>
                          {isCurrent && <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400, marginTop: 2 }}>début {fmtDate(r.start_date)}</div>}
                        </td>
                        <td style={{ ...td, textAlign: "left", color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>
                          {fmtDate(r.cycle_start)} → {fmtDate(r.cycle_end_incl)}
                        </td>
                        {isCurrent ? (
                          <>
                            <td style={{ ...td, textAlign: "left", fontSize: 11, color: r.due ? "#F5C518" : "var(--text)", whiteSpace: "nowrap" }}>
                              <CalendarClock size={11} style={{ display: "inline", marginRight: 4, verticalAlign: "-1px" }} />{fmtDate(r.settle_date)}
                            </td>
                            <td style={{ ...td, textAlign: "center" }}><StatusBadge due={r.due} days_overdue={r.days_overdue} /></td>
                          </>
                        ) : (
                          <td style={{ ...td, textAlign: "left", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.settled_at ? fmtDate(r.settled_at) : "—"}</td>
                        )}
                        <td style={{ ...td, color: r.resultat_periode >= 0 ? "#10B981" : "#EF4444", fontWeight: 600 }}>
                          {txs.length > 0 ? (
                            <button
                              onClick={() => setExpandedTx(isTxOpen ? null : r.player_id)}
                              title={`Voir les ${txs.length} transactions du cycle (dépôts/retraits composant ce résultat)`}
                              style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit", fontWeight: "inherit", fontSize: "inherit", fontVariantNumeric: "tabular-nums", display: "inline-flex", alignItems: "center", gap: 4, padding: 0 }}
                            >
                              {signed(r.resultat_periode)}
                              {isTxOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                            </button>
                          ) : (
                            signed(r.resultat_periode)
                          )}
                        </td>
                        <td style={td}>
                          {isCurrent ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                              <input
                                type="number" min={0} step={1}
                                value={mainsEdits[r.player_id] ?? String(r.mains)}
                                onChange={(e) => setMainsEdits((m) => ({ ...m, [r.player_id]: e.target.value }))}
                                style={{ width: 90, padding: "5px 8px", borderRadius: 6, fontSize: 12, textAlign: "right", background: "var(--bg-base)", color: "var(--text)", border: "1px solid var(--border)", outline: "none", fontVariantNumeric: "tabular-nums" }}
                              />
                              {edited && (
                                <button onClick={() => saveMains(r.player_id)} disabled={busy === r.player_id} title="Enregistrer les mains" style={{ background: "rgba(16,185,129,0.15)", border: "none", borderRadius: 6, cursor: "pointer", color: "#10B981", padding: "5px 6px", display: "inline-flex" }}>
                                  <Check size={13} />
                                </button>
                              )}
                            </span>
                          ) : (
                            r.mains.toLocaleString("fr-FR")
                          )}
                        </td>
                        <td style={{ ...td, color: r.c >= 0 ? "var(--text)" : "#EF4444" }}>{signed(r.c)}</td>
                        <td style={{ ...td, color: r.t > 0 ? "#F5C518" : "var(--text-muted)" }}>{signed(r.t)}</td>
                        <td title={partTooltip} style={{ ...td, fontWeight: 700, fontSize: 13, color: partCercleColor(r.operator_pnl_projected), cursor: "help" }}>
                          {signed(r.operator_pnl_projected)}
                        </td>
                        <td style={td}>
                          {isCurrent ? (
                            rbEditing === r.player_id ? (
                              <input
                                autoFocus
                                type="text"
                                inputMode="decimal"
                                value={rbDraft}
                                onChange={(e) => setRbDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveRb(r.player_id);
                                  if (e.key === "Escape") setRbEditing(null);
                                }}
                                onBlur={() => setRbEditing(null)}
                                disabled={busy === r.player_id}
                                placeholder="0"
                                style={{ width: 80, padding: "5px 8px", borderRadius: 6, fontSize: 12, textAlign: "right", background: "var(--bg-base)", color: "var(--text)", border: "1px solid #F5C518", outline: "none", fontVariantNumeric: "tabular-nums" }}
                              />
                            ) : (
                              <button
                                title={RB_MANUEL_TOOLTIP}
                                onClick={() => { setRbEditing(r.player_id); setRbDraft((r.rb_manual ?? 0) > 0 ? String(r.rb_manual) : ""); }}
                                style={{ background: "transparent", border: "1px dashed var(--border)", borderRadius: 6, cursor: "pointer", padding: "4px 10px", fontSize: 12, fontVariantNumeric: "tabular-nums" }}
                              >
                                <RbValue amount={r.rb_manual ?? 0} />
                              </button>
                            )
                          ) : (
                            <span title={RB_MANUEL_TOOLTIP} style={{ cursor: "help" }}><RbValue amount={r.rb_manual ?? 0} /></span>
                          )}
                        </td>
                        <td style={{ padding: "10px 10px 10px 16px", textAlign: "left" }}><ReglementCell reglement={r.reglement_projected} /></td>
                        <td style={{ ...td, textAlign: "center" }}><ConditionBadge row={r} /></td>
                        {isCurrent && (
                          <td style={{ ...td, textAlign: "center" }}>
                            <Btn onClick={() => openRecap(r)} disabled={busy === r.player_id} style={{ fontSize: 11, gap: 5, padding: "6px 10px" }}>
                              <Scale size={13} /> Régler
                            </Btn>
                          </td>
                        )}
                      </tr>
                      {isWalletOpen && (
                        <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-surface)" }}>
                          <td colSpan={COLS} style={{ padding: "16px 20px" }}>
                            <PlayerWalletsPanel
                              playerId={r.player_id}
                              gameId={gameId}
                              gameLabel="QQPK"
                              gameWallets={gw}
                              cashouts={co}
                              onClose={() => setExpandedWallet(null)}
                            />
                          </td>
                        </tr>
                      )}
                      {isTxOpen && (
                        <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-base)" }}>
                          <td colSpan={COLS} style={{ padding: "12px 20px" }}>
                            <CycleTxList txs={txs} resultat={r.resultat_periode} onClose={() => setExpandedTx(null)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Historique complet des cycles réglés */}
      {history.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 12 }}>Historique des cycles réglés</h3>
          <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ ...th, textAlign: "left" }}>Joueur</th>
                  <th style={{ ...th, textAlign: "left" }}>Cycle</th>
                  <th style={th}>Résultat</th>
                  <th style={th}>Mains</th>
                  <th style={th}>C final</th>
                  <th style={th}>T final</th>
                  <th title={PART_CERCLE_SETTLED_TOOLTIP} style={th}>Part Cercle</th>
                  <th title={RB_MANUEL_TOOLTIP} style={{ ...th, cursor: "help" }}>RB (manuel)</th>
                  <th style={{ ...th, textAlign: "left", paddingLeft: 16 }}>Règlement</th>
                  <th style={{ ...th, textAlign: "center" }}>30k</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.player_id}-${h.cycle_start}`} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ ...td, textAlign: "left", fontWeight: 600, color: "var(--text)" }}>{h.player_name}</td>
                    <td style={{ ...td, textAlign: "left", color: "var(--text-muted)", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(h.cycle_start)} → {fmtDate(h.cycle_end_incl)}</td>
                    <td style={{ ...td, color: h.resultat_periode >= 0 ? "#10B981" : "#EF4444" }}>{signed(h.resultat_periode)}</td>
                    <td style={td}>{h.mains.toLocaleString("fr-FR")}</td>
                    <td style={td}>{signed(h.c)}</td>
                    <td style={td}>{signed(h.t)}</td>
                    <td title={PART_CERCLE_SETTLED_TOOLTIP} style={{ ...td, fontWeight: 700, color: partCercleColor(h.operator_pnl), cursor: "help" }}>{signed(h.operator_pnl)}</td>
                    <td title={RB_MANUEL_TOOLTIP} style={{ ...td, cursor: "help" }}><RbValue amount={h.rb_manual ?? 0} /></td>
                    <td style={{ padding: "10px 10px 10px 16px", textAlign: "left" }}><ReglementCell reglement={h.reglement} /></td>
                    <td style={{ ...td, textAlign: "center" }}><ConditionBadge row={h} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recap modal (règlement du cycle courant) */}
      <Modal open={!!recap} onClose={() => setRecap(null)} title="Régler le cycle — récapitulatif">
        {recap && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {!recap.preview.ok ? (
              <div style={{ padding: 14, borderRadius: 8, background: "rgba(239,68,68,0.1)", color: "#EF4444", fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
                <AlertTriangle size={16} /> {recap.preview.error ?? "Impossible de régler ce cycle."}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: "var(--text)" }}>
                  <b>{recap.player.player_name}</b> · cycle <b>{fmtDate(recap.preview.cycle!.cycle_start)} → {fmtDate(recap.preview.cycle!.cycle_end_incl)}</b>
                  <span style={{ color: "var(--text-dim)" }}> (échéance {fmtDate(recap.preview.cycle!.settle_date)})</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
                  <RecapLine label="Résultat (net cycle)" value={`${signed(recap.preview.resultat_periode ?? 0)} USDT`} />
                  <RecapLine label="Mains" value={(recap.preview.mains ?? 0).toLocaleString("fr-FR")} />
                  <RecapLine label="C (cycle)" value={signed(recap.preview.c ?? 0)} />
                  <RecapLine label="T (position)" value={signed(recap.preview.t ?? 0)} />
                </div>
                <div style={{ padding: 14, borderRadius: 8, background: "var(--bg-base)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Règlement du cycle (réel — ce que le lock écrit)</div>
                  {(() => {
                    const reglement = recap.preview.reglement ?? 0;
                    const reg = dueLabel(reglement);
                    // Direction en toutes lettres (le "−1 511,40" nu se lisait comme une
                    // perte alors que règlement <0 = le joueur paie le Cercle). La phrase
                    // porte le sens, le montant moteur reste affiché en dessous.
                    const sentence = Math.abs(reglement) < 0.005
                      ? "Rien à régler (0,00 USDT)"
                      : reglement > 0
                        ? `Le Cercle paie ${fmt(reglement)} USDT au joueur`
                        : `Le joueur paie ${fmt(reglement)} USDT au Cercle`;
                    return (
                      <div title={reg.hint} style={{ cursor: "help" }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: reg.color, display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {Math.abs(reglement) >= 0.005 && (reglement > 0 ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />)}
                          {sentence}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                          règlement moteur : {reg.text}
                        </div>
                      </div>
                    );
                  })()}
                  {/* Divergence prévisionnel/réel : la gate 30k a annulé la couverture. */}
                  {recap.preview.condition_30k_applied && (
                    <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", fontSize: 11, color: "#EF4444", fontWeight: 600 }}>
                      ⚠️ Non couvert à ce jour : 0,00 réglable (mains &lt;30k). Le prévisionnel affiché sur le tableau
                      ({signed(recap.preview.operator_pnl_projected ?? 0)} USDT) est conditionnel — il ne s&apos;applique
                      que si le joueur atteint 30 000 mains avant la fin du cycle.
                    </div>
                  )}
                  <div title={PART_CERCLE_SETTLED_TOOLTIP} style={{ fontSize: 11, color: partCercleColor(recap.preview.operator_pnl ?? 0), marginTop: 6, fontWeight: 600, cursor: "help" }}>
                    Part Cercle (réelle au lock) : {signed(recap.preview.operator_pnl ?? 0)} USDT
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 6 }}>Condition 30k :</span>
                    <ConditionBadge row={{ mains: recap.preview.mains ?? 0, condition_30k_applied: !!recap.preview.condition_30k_applied }} />
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  Reset sec : une fois réglé, le cycle devient immuable et le suivant repart à C=0/T=0 (aucun carry).
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
              <Btn onClick={() => setRecap(null)} style={{ background: "var(--bg-base)" }}>Annuler</Btn>
              {recap.preview.ok && (
                <Btn variant="primary" onClick={confirmSettle} disabled={confirming}>{confirming ? "..." : "Confirmer le règlement"}</Btn>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function RecapLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// Liste des dépôts/retraits composant le résultat du cycle — affichage pur (les montants
// viennent du loader avec les mêmes filtres que le net ; le footer réaffiche le résultat
// moteur, aucune somme recalculée ici).
function CycleTxList({ txs, resultat, onClose }: { txs: CycleTx[]; resultat: number; onClose: () => void }) {
  const fmtTxDate = (t: CycleTx) => {
    const raw = t.tx_datetime ?? t.tx_date;
    const iso = raw.includes("T") ? raw : raw + "T00:00:00Z";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return t.tx_date;
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
  };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>
          Transactions du cycle ({txs.length}) — dépôts & retraits composant le résultat
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: 11, padding: 0 }}>✕ fermer</button>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
        {txs.map((t, i) => {
          const isDeposit = t.type === "deposit";
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 12px", borderTop: i > 0 ? "1px solid var(--border)" : "none", fontSize: 12 }}>
              <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", width: 78 }}>{fmtTxDate(t)}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, width: 76, color: isDeposit ? "#EF4444" : "#10B981", fontWeight: 600 }}>
                {isDeposit ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
                {isDeposit ? "Dépôt" : "Retrait"}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, color: isDeposit ? "#EF4444" : "#10B981", width: 120, textAlign: "right" }}>
                {isDeposit ? "−" : "+"}{fmt(t.amount)} USDT
              </span>
              {t.source === "manual" && (
                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(136,136,160,0.15)", color: "var(--text-muted)" }}>manuel</span>
              )}
              <div style={{ flex: 1 }} />
              {t.tron_tx_hash && (
                <a href={TRONSCAN_TX + t.tron_tx_hash} target="_blank" rel="noopener noreferrer" title={t.tron_tx_hash} style={{ color: "var(--text-dim)", display: "inline-flex" }}>
                  <ExternalLink size={12} />
                </a>
              )}
            </div>
          );
        })}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--border)", background: "var(--bg-surface)", fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)" }}>Net du cycle (retraits − dépôts) :</span>
          <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", color: resultat >= 0 ? "#10B981" : "#EF4444" }}>{signed(resultat)} USDT</span>
        </div>
      </div>
    </div>
  );
}
