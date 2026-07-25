"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, BadgeCheck, Banknote, Clock, ExternalLink, Unlock,
  ArrowDownLeft, ArrowUpRight,
} from "lucide-react";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import type { HubSettlement, OverdueBucket, PaymentsTotals } from "@/lib/manual-settlement-engine";

/**
 * Paiements — vue agrégée. Aucune math métier ici (invariant #2) : tous les montants
 * arrivent déjà calculés par lib/manual-settlement-engine.ts. Ce composant se limite à
 * l'affichage, aux filtres, et à une somme de présentation (le « net cumulé » de la liste
 * filtrée, qui n'additionne que des montants déjà figés en USDT). Arrondi au rendu
 * uniquement (invariant #9).
 *
 * Convention de signe, identique aux pages room :
 *   amount_due_usdt > 0  →  sortie, on doit au joueur
 *   amount_due_usdt < 0  →  entrée, le joueur nous doit
 *
 * ATTENTION — OverdueBucket.net_usdt n'est PAS un montant dû : c'est le net joueur brut,
 * sans action_pct (aucun règlement n'existe encore, donc aucun % n'est figé). Il est rendu
 * en neutre, jamais avec le vocabulaire « on lui doit / il nous doit ».
 */

const TRONSCAN_TX = "https://tronscan.org/#/transaction/";

function fmt(n: number): string {
  return Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s.slice(0, 10) + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });
}
function today(): string { return new Date().toISOString().slice(0, 10); }

/** Sens du règlement — la formulation demandée par Baki, explicite dans la colonne. */
function direction(due: number): { label: string; color: string; icon: typeof ArrowUpRight | null } {
  if (Math.abs(due) < 0.005) return { label: "Rien à payer", color: "var(--text-dim)", icon: null };
  if (due > 0) return { label: "On lui doit", color: "#EF4444", icon: ArrowUpRight };
  return { label: "Il nous doit", color: "#10B981", icon: ArrowDownLeft };
}

// ── Petits blocs de présentation ─────────────────────────

function RoomBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 5, whiteSpace: "nowrap",
      background: `${color}1A`, color, border: `1px solid ${color}44`,
    }}>{label}</span>
  );
}

function WeekChip({ label }: { label: string | null }) {
  if (!label) return <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 5,
      background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)",
    }}>{label}</span>
  );
}

/** Ancienneté d'un règlement locké non payé — l'autre forme d'oubli. */
function AgeBadge({ days }: { days: number }) {
  if (days < 3) return null;
  const critical = days >= 14;
  const warn = days >= 7;
  const color = critical ? "#EF4444" : warn ? "#F59E0B" : "var(--text-dim)";
  return (
    <span title={`Locké depuis ${days} jour${days > 1 ? "s" : ""} sans paiement`} style={{
      display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, fontWeight: 700,
      padding: "2px 7px", borderRadius: 5, color, background: `${color}14`, border: `1px solid ${color}33`,
    }}><Clock size={10} /> {days}j</span>
  );
}

function Tile({ label, value, sub, color, alert }: { label: string; value: string; sub?: string; color: string; alert?: boolean }) {
  return (
    <div style={{
      flex: "1 1 190px", padding: "14px 16px", borderRadius: 12,
      background: "var(--bg-elevated)",
      border: `1px solid ${alert ? "rgba(239,68,68,0.35)" : "var(--border)"}`,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ icon, title, count, tone = "var(--text)" }: { icon: React.ReactNode; title: string; count: number; tone?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
      {icon}
      <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: tone }}>{title}</span>
      <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 10, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>{count}</span>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "22px 16px", textAlign: "center", fontSize: 12, color: "var(--text-dim)", border: "1px dashed var(--border)", borderRadius: 10 }}>
      {children}
    </div>
  );
}

const card: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-base)", overflow: "hidden" };
const rowBase: React.CSSProperties = { display: "grid", gap: 12, alignItems: "center", padding: "11px 14px", borderBottom: "1px solid var(--border)" };
const selectStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer", outline: "none" };
const inputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none", colorScheme: "dark" };

type SortKey = "age" | "amount" | "room";

export default function PaymentsClient({
  pending, overdue, paid, totals, rooms, graceDays,
  markPaidAction, unlockAction,
}: {
  pending: HubSettlement[];
  overdue: OverdueBucket[];
  paid: HubSettlement[];
  totals: PaymentsTotals;
  rooms: string[];
  graceDays: number;
  markPaidAction: (settlementId: number, txHash?: string, paidDate?: string) => Promise<{ ok: boolean; error?: string }>;
  unlockAction: (settlementId: number) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();

  const [sort, setSort] = useState<SortKey>("age");
  const [payTarget, setPayTarget] = useState<HubSettlement | null>(null);
  const [payDate, setPayDate] = useState(today());
  const [payHash, setPayHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  // Filtres historique
  const [fRoom, setFRoom] = useState("");
  const [fPlayer, setFPlayer] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");

  const sortedPending = useMemo(() => {
    const rows = [...pending];
    if (sort === "amount") rows.sort((a, b) => Math.abs(b.amount_due_usdt) - Math.abs(a.amount_due_usdt));
    else if (sort === "room") rows.sort((a, b) => a.room_label.localeCompare(b.room_label) || b.age_days - a.age_days);
    else rows.sort((a, b) => b.age_days - a.age_days);
    return rows;
  }, [pending, sort]);

  const paidPlayers = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of paid) m.set(s.player_id, s.player_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [paid]);

  const filteredPaid = useMemo(() => paid.filter(s =>
    (!fRoom || s.room_label === fRoom) &&
    (!fPlayer || s.player_id === Number(fPlayer)) &&
    (!fFrom || (s.paid_on ?? "") >= fFrom) &&
    (!fTo || (s.paid_on ?? "") <= fTo)
  ), [paid, fRoom, fPlayer, fFrom, fTo]);

  const paidTotal = useMemo(() => filteredPaid.reduce((acc, s) => acc + s.amount_due_usdt, 0), [filteredPaid]);

  function openPay(s: HubSettlement) {
    setPayTarget(s);
    setPayDate(today());
    setPayHash("");
  }

  async function confirmPay() {
    if (!payTarget) return;
    setBusy(true);
    try {
      const res = await markPaidAction(payTarget.id, payHash.trim() || undefined, payDate);
      if (!res.ok) { alert(res.error ?? "Erreur lors du marquage payé"); return; }
      setPayTarget(null);
      router.refresh();
    } finally { setBusy(false); }
  }

  async function unlock(s: HubSettlement) {
    if (!confirm(`Délock le règlement de ${s.player_name} (${s.room_label}) ?\nSes ${s.tx_count} transactions redeviennent sélectionnables dans la room.`)) return;
    setRowBusy(s.id);
    try {
      const res = await unlockAction(s.id);
      if (!res.ok) { alert(res.error ?? "Erreur"); return; }
      router.refresh();
    } finally { setRowBusy(null); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>

      {/* ── En-tête : totaux ─────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Tile
          label="On doit (total)"
          value={`${fmt(totals.owed_to_players)} USDT`}
          sub="sorties à faire, toutes rooms"
          color="#EF4444"
        />
        <Tile
          label="On nous doit"
          value={`${fmt(totals.owed_by_players)} USDT`}
          sub="entrées attendues"
          color="#10B981"
        />
        <Tile
          label="Règlements en attente"
          value={String(totals.pending_count)}
          sub={totals.oldest_pending_days > 0 ? `le plus ancien : ${totals.oldest_pending_days} j` : "aucun en attente"}
          color="var(--text)"
        />
        <Tile
          label="Impayés en retard"
          value={String(totals.overdue_count)}
          sub={totals.overdue_count > 0 ? "semaines jamais réglées" : "rien d'oublié ✓"}
          color={totals.overdue_count > 0 ? "#EF4444" : "var(--text)"}
          alert={totals.overdue_count > 0}
        />
      </div>

      {/* Tx orphelines : game_id NULL → invisibles de tous les flux de règlement, donc
          impossibles à régler. Elles n'ont nulle part ailleurs où apparaître. */}
      {totals.unassigned_tx > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 9, padding: "10px 14px", borderRadius: 10,
          background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)", fontSize: 12, color: "#F59E0B",
        }}>
          <AlertTriangle size={14} />
          <span>
            <b>{totals.unassigned_tx} transaction{totals.unassigned_tx > 1 ? "s" : ""} sans room</b> (game_id vide) —
            non réglable{totals.unassigned_tx > 1 ? "s" : ""} en l&apos;état et invisible{totals.unassigned_tx > 1 ? "s" : ""} des pages room. À réattribuer à un game.
          </span>
        </div>
      )}

      {/* ── 1. À régler ──────────────────────────────────── */}
      <section>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <SectionTitle icon={<Banknote size={14} color="#F5C518" />} title="À régler" count={pending.length} />
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: 11, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
            Trier par
            <select value={sort} onChange={e => setSort(e.target.value as SortKey)} style={selectStyle}>
              <option value="age">Ancienneté</option>
              <option value="amount">Montant</option>
              <option value="room">Room</option>
            </select>
          </label>
        </div>

        {sortedPending.length === 0 ? (
          <EmptyState>Aucun règlement en attente — tout est payé ✓</EmptyState>
        ) : (
          <div style={card}>
            {sortedPending.map(s => {
              const dir = direction(s.amount_due_usdt);
              const Icon = dir.icon;
              return (
                <div key={s.id} style={{ ...rowBase, gridTemplateColumns: "88px minmax(120px,1fr) 130px 128px 150px auto" }}>
                  <RoomBadge label={s.room_label} color={s.room_color} />

                  <a href={`${s.room_base_path}?player=${s.player_id}`} title="Ouvrir le joueur dans sa room"
                    style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                    {s.player_name}
                  </a>

                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <WeekChip label={s.week_label} />
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{s.tx_count} tx</span>
                  </span>

                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {fmtDate(s.period_start)} → {fmtDate(s.period_end)}
                  </span>

                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    {Icon && <Icon size={14} color={dir.color} />}
                    <span style={{ fontSize: 14, fontWeight: 700, color: dir.color, fontVariantNumeric: "tabular-nums" }}>{fmt(s.amount_due_usdt)}</span>
                    <span style={{ fontSize: 10, color: dir.color, opacity: 0.85 }}>{dir.label}</span>
                  </span>

                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                    <AgeBadge days={s.age_days} />
                    <button onClick={() => openPay(s)} disabled={rowBusy === s.id} style={{
                      display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 7,
                      fontSize: 11, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)",
                      border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", whiteSpace: "nowrap",
                    }}><BadgeCheck size={12} /> Marquer payé</button>
                    <button onClick={() => unlock(s)} disabled={rowBusy === s.id} title="Délock — les tx redeviennent sélectionnables"
                      style={{ display: "inline-flex", alignItems: "center", padding: "6px 8px", borderRadius: 7, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}>
                      <Unlock size={12} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 2. Impayés / en retard ───────────────────────── */}
      <section>
        <SectionTitle
          icon={<AlertTriangle size={14} color={overdue.length > 0 ? "#EF4444" : "var(--text-muted)"} />}
          title="Impayés / en retard"
          count={overdue.length}
          tone={overdue.length > 0 ? "#EF4444" : "var(--text)"}
        />

        {overdue.length === 0 ? (
          <EmptyState>Aucune semaine passée laissée de côté — rien d&apos;oublié ✓</EmptyState>
        ) : (
          <>
            <div style={card}>
              {overdue.map(b => {
                const critical = b.severity === "critical";
                const accent = critical ? "#EF4444" : "#F59E0B";
                return (
                  <div key={`${b.player_id}-${b.room_label}-${b.week_monday}`}
                    style={{ ...rowBase, gridTemplateColumns: "88px minmax(120px,1fr) 96px 120px 150px auto", borderLeft: `3px solid ${accent}` }}>
                    <RoomBadge label={b.room_label} color={b.room_color} />

                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{b.player_name}</span>
                      {b.never_settled && (
                        <span title="Ce joueur n'a JAMAIS été réglé dans cette room" style={{
                          fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
                          background: "rgba(239,68,68,0.14)", color: "#EF4444", border: "1px solid rgba(239,68,68,0.3)",
                        }}>JAMAIS RÉGLÉ</span>
                      )}
                    </span>

                    <WeekChip label={b.week_label} />

                    <span style={{ fontSize: 11, fontWeight: 700, color: accent }}>
                      {critical ? "🔴" : "🟠"} {b.weeks_late} sem. de retard
                    </span>

                    {/* Net JOUEUR brut — pas un montant dû : aucun action_pct n'est encore
                        appliqué. Rendu en neutre pour ne jamais se lire comme une dette. */}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
                      title="Net joueur brut (retraits − dépôts) — le montant dû ne sera connu qu'au règlement, après application de l'action %">
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                        {b.net_usdt >= 0 ? "+" : "−"}{fmt(b.net_usdt)}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>net brut · {b.tx_count} tx</span>
                    </span>

                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                      {b.unconvertible > 0 && (
                        <span title={`${b.unconvertible} tx sans taux de change — exclues du net affiché`}
                          style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B" }}>⚠ {b.unconvertible}</span>
                      )}
                      <a href={`${b.room_base_path}?player=${b.player_id}`} style={{
                        display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 7,
                        fontSize: 11, fontWeight: 600, background: `${accent}1A`, color: accent,
                        border: `1px solid ${accent}55`, textDecoration: "none", whiteSpace: "nowrap",
                      }}>Aller régler <ExternalLink size={11} /></a>
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8 }}>
              Une semaine n&apos;apparaît ici qu&apos;après {graceDays} jours de délai de grâce — tu as le lundi et le mardi
              pour régler le week-end sans qu&apos;elle passe au rouge.
            </div>
          </>
        )}
      </section>

      {/* ── 3. Réglés (historique) ───────────────────────── */}
      <section>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <SectionTitle icon={<BadgeCheck size={14} color="#10B981" />} title="Réglés" count={filteredPaid.length} />
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 12 }}>
            <input type="date" value={fFrom} onChange={e => setFFrom(e.target.value)} title="Payé à partir du" style={inputStyle} />
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>→</span>
            <input type="date" value={fTo} onChange={e => setFTo(e.target.value)} title="Payé jusqu'au" style={inputStyle} />
            <select value={fRoom} onChange={e => setFRoom(e.target.value)} style={selectStyle}>
              <option value="">Toutes les rooms</option>
              {rooms.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={fPlayer} onChange={e => setFPlayer(e.target.value)} style={selectStyle}>
              <option value="">Tous les joueurs</option>
              {paidPlayers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            {(fRoom || fPlayer || fFrom || fTo) && (
              <button onClick={() => { setFRoom(""); setFPlayer(""); setFFrom(""); setFTo(""); }}
                style={{ ...selectStyle, color: "var(--text-muted)" }}>✕ Reset</button>
            )}
          </div>
        </div>

        {filteredPaid.length === 0 ? (
          <EmptyState>{paid.length === 0 ? "Aucun règlement payé pour l'instant." : "Aucun règlement ne correspond à ces filtres."}</EmptyState>
        ) : (
          <>
            <div style={card}>
              {filteredPaid.map(s => {
                const dir = direction(s.amount_due_usdt);
                return (
                  <div key={s.id} style={{ ...rowBase, gridTemplateColumns: "88px minmax(120px,1fr) 118px 110px 150px auto" }}>
                    <RoomBadge label={s.room_label} color={s.room_color} />
                    <a href={`${s.room_base_path}?player=${s.player_id}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                      {s.player_name}
                    </a>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <WeekChip label={s.week_label} />
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{s.tx_count} tx</span>
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }} title="Date de paiement">
                      {fmtDate(s.paid_on)}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: dir.color, fontVariantNumeric: "tabular-nums" }}>{fmt(s.amount_due_usdt)}</span>
                      <span style={{ fontSize: 10, color: dir.color, opacity: 0.8 }}>{dir.label}</span>
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                      {s.tx_hash ? (
                        <a href={TRONSCAN_TX + s.tx_hash} target="_blank" rel="noreferrer" title={s.tx_hash}
                          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#38bdf8", textDecoration: "none", fontSize: 11, fontFamily: "monospace" }}>
                          {s.tx_hash.slice(0, 8)}… <ExternalLink size={10} />
                        </a>
                      ) : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 14, padding: "10px 14px", fontSize: 11, color: "var(--text-muted)" }}>
              <span>{filteredPaid.length} règlement{filteredPaid.length > 1 ? "s" : ""}</span>
              <span>·</span>
              <span>Net cumulé : <b style={{ color: Math.abs(paidTotal) < 0.005 ? "var(--text-muted)" : paidTotal > 0 ? "#EF4444" : "#10B981" }}>{fmt(paidTotal)} USDT</b> {Math.abs(paidTotal) < 0.005 ? "" : paidTotal > 0 ? "sortis" : "rentrés"}</span>
            </div>
          </>
        )}
      </section>

      {/* ── Modale « marquer payé » ──────────────────────── */}
      <Modal open={!!payTarget} onClose={() => setPayTarget(null)} title="Marquer ce règlement payé">
        {payTarget && (() => {
          const dir = direction(payTarget.amount_due_usdt);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, color: "var(--text)" }}>
                <RoomBadge label={payTarget.room_label} color={payTarget.room_color} />
                <b>{payTarget.player_name}</b>
                <WeekChip label={payTarget.week_label} />
                <span style={{ color: "var(--text-dim)" }}>· {payTarget.tx_count} tx</span>
              </div>

              <div style={{ padding: 14, borderRadius: 8, background: "var(--bg-base)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Montant du règlement</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: dir.color, display: "inline-flex", alignItems: "center", gap: 7 }}>
                  {dir.icon && <dir.icon size={17} />}
                  {fmt(payTarget.amount_due_usdt)} USDT
                  <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.85 }}>· {dir.label}</span>
                </div>
              </div>

              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Date du paiement</span>
                <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} style={{ ...inputStyle, fontSize: 13, padding: "9px 12px" }} />
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Hash / lien de la transaction (optionnel)</span>
                <input value={payHash} onChange={e => setPayHash(e.target.value)} placeholder="tx_hash TRON" spellCheck={false}
                  style={{ ...inputStyle, fontSize: 12, padding: "9px 12px", fontFamily: "monospace" }} />
              </label>

              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                Le règlement passe en « réglé » ici <b>et</b> dans {payTarget.room_label} — c&apos;est la même ligne.
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 2 }}>
                <Btn variant="secondary" onClick={() => setPayTarget(null)}>Annuler</Btn>
                <Btn variant="primary" onClick={confirmPay} disabled={busy || !/^\d{4}-\d{2}-\d{2}$/.test(payDate)}>
                  <BadgeCheck size={14} /> {busy ? "…" : "Confirmer le paiement"}
                </Btn>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
