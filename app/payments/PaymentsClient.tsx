"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, BadgeCheck, Banknote, Clock, ExternalLink, Unlock,
  ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, X,
} from "lucide-react";
import Btn from "@/components/Btn";
import Modal from "@/components/Modal";
import type {
  HubSettlement, OverdueBucket, PaymentsTotals, PlayerPendingGroup, PlayerOverdueGroup,
} from "@/lib/manual-settlement-engine";

/**
 * Paiements — vue agrégée. Aucune math métier ici (invariant #2) : tous les montants
 * arrivent déjà calculés par lib/manual-settlement-engine.ts, y compris les regroupements
 * par joueur (fonctions pures du moteur). Ce composant se limite à l'affichage, aux filtres,
 * et à des sommes de présentation sur des montants déjà figés en USDT. Arrondi au rendu
 * uniquement (invariant #9), jamais de comparaison de flottants à l'égalité.
 *
 * Convention de signe, identique aux pages room :
 *   amount_due_usdt > 0  →  sortie, on doit au joueur
 *   amount_due_usdt < 0  →  entrée, le joueur nous doit
 * C'est ce signe qui fait la compensation cross-room du solde net par joueur : −300 sur
 * KKPOKER + 500 sur A5NUTS = +200, on lui doit 200. Le net est une VUE : il n'est jamais
 * persisté et jamais passé à une action. Tout « Marquer payé » agit sur des settlement_id
 * réels, un par un.
 *
 * ATTENTION — OverdueBucket.net_usdt (et le net_brut_usdt de son groupe) n'est PAS un montant
 * dû : c'est le net joueur brut, sans action_pct (aucun règlement n'existe encore, donc aucun
 * % n'est figé). Rendu en neutre, jamais avec le vocabulaire « on lui doit / il nous doit ».
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

/** Seuil de présentation — jamais `=== 0` sur un flottant (invariant #9). */
const ZERO = 0.005;

/**
 * CONVENTION UNIQUE DE L'APP (décision Baki 2026-07-25) : + vert = ça rentre · − rouge = ça sort.
 *
 * `amount_due_usdt` = (retraits − dépôts) × action% — exactement la MÊME formule que `my_pnl`
 * dans lib/queries.ts (l.587), lui-même aliasé en `agency_cut_usdt` (l.1517) : c'est le chiffre
 * doré « Agency cut » du dashboard, de Top Contributors, de la liste Joueurs et de la fiche.
 * Partout ailleurs il se lit donc « positif = ce que le joueur te rapporte ». Cette page était
 * le seul endroit à prendre le sens inverse (rouge « on lui doit » sur un positif) — d'où deux
 * couleurs pour un seul et même nombre. Elle est désormais alignée sur le reste :
 *
 *   due > 0  →  + vert  · « Il nous doit »   (ça rentre)
 *   due < 0  →  − rouge · « On lui doit »    (ça sort)
 *
 * Affichage uniquement : aucun montant, aucun calcul, aucune écriture n'a changé. Le
 * commentaire `// positive = operator owes player` de computeTotals() était la source de
 * l'erreur de lecture, il est corrigé là-bas.
 */
function agencySigned(due: number): string {
  return (due >= 0 ? "+" : "−") + fmt(due);
}

/** Sens du règlement — la formulation demandée par Baki, explicite dans la colonne. */
function direction(due: number): { label: string; color: string; icon: typeof ArrowUpRight | null } {
  if (Math.abs(due) < ZERO) return { label: "Rien à payer", color: "var(--text-dim)", icon: null };
  if (due > 0) return { label: "Il nous doit", color: "#10B981", icon: ArrowDownLeft };
  return { label: "On lui doit", color: "#EF4444", icon: ArrowUpRight };
}

/** Sens d'un solde net compensé — un net à zéro n'est PAS « rien à faire ». */
function netDirection(net: number): { label: string; color: string } {
  if (Math.abs(net) < ZERO) return { label: "équilibré après compensation", color: "var(--text-muted)" };
  if (net > 0) return { label: "il nous doit", color: "#10B981" };
  return { label: "on lui doit", color: "#EF4444" };
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

/** Checkbox à 3 états — `indeterminate` n'existe qu'en propriété DOM, pas en attribut React. */
function TriCheckbox({ checked, indeterminate, onChange, title }: { checked: boolean; indeterminate?: boolean; onChange: () => void; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate && !checked; }, [indeterminate, checked]);
  return (
    <input
      ref={ref} type="checkbox" checked={checked} title={title}
      onClick={e => e.stopPropagation()}
      onChange={onChange}
      style={{ accentColor: "#F5C518", cursor: "pointer", width: 15, height: 15, flexShrink: 0 }}
    />
  );
}

const card: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-base)", overflow: "hidden" };
const rowBase: React.CSSProperties = { display: "grid", gap: 12, alignItems: "center", padding: "11px 14px", borderBottom: "1px solid var(--border)" };
const selectStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", cursor: "pointer", outline: "none" };
const inputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600, background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)", outline: "none", colorScheme: "dark" };

type SortKey = "age" | "amount" | "room";
type ViewMode = "grouped" | "flat";

export default function PaymentsClient({
  pending, pendingGroups, overdue, overdueGroups, paid, totals, rooms, graceDays,
  markPaidAction, markPaidBulkAction, unlockAction,
}: {
  pending: HubSettlement[];
  pendingGroups: PlayerPendingGroup[];
  overdue: OverdueBucket[];
  overdueGroups: PlayerOverdueGroup[];
  paid: HubSettlement[];
  totals: PaymentsTotals;
  rooms: string[];
  graceDays: number;
  markPaidAction: (settlementId: number, txHash?: string, paidDate?: string) => Promise<{ ok: boolean; error?: string }>;
  markPaidBulkAction: (settlementIds: number[], txHash?: string, paidDate?: string) => Promise<{ paid: number; failures: { id: number; error: string }[] }>;
  unlockAction: (settlementId: number) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();

  const [view, setView] = useState<ViewMode>("grouped");
  const [sort, setSort] = useState<SortKey>("age");
  const [payTarget, setPayTarget] = useState<HubSettlement | null>(null);
  const [payDate, setPayDate] = useState(today());
  const [payHash, setPayHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  // Dépli — les groupes sont repliés par défaut : c'est tout l'intérêt du regroupement.
  const [openPlayers, setOpenPlayers] = useState<Set<number>>(new Set());
  const [openOverdue, setOpenOverdue] = useState<Set<string>>(new Set());

  // Multi-select : des settlement_id réels, jamais un agrégat.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDate, setBulkDate] = useState(today());
  const [bulkHash, setBulkHash] = useState("");

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

  // Même critère de tri appliqué au niveau groupe (le moteur les rend déjà triés par ancienneté).
  const sortedGroups = useMemo(() => {
    const gs = [...pendingGroups];
    if (sort === "amount") gs.sort((a, b) => Math.abs(b.net_usdt) - Math.abs(a.net_usdt));
    else if (sort === "room") gs.sort((a, b) => (a.rooms[0]?.label ?? "").localeCompare(b.rooms[0]?.label ?? "") || b.oldest_age_days - a.oldest_age_days);
    else gs.sort((a, b) => b.oldest_age_days - a.oldest_age_days);
    return gs;
  }, [pendingGroups, sort]);

  /** Joueurs ayant AUSSI des semaines jamais réglées : leur net compensé est incomplet. */
  const playersWithOverdue = useMemo(() => {
    const m = new Map<number, number>();
    for (const g of overdueGroups) m.set(g.player_id, (m.get(g.player_id) ?? 0) + g.weeks_count);
    return m;
  }, [overdueGroups]);

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

  /**
   * Récap de la sélection. Le net seul ne suffit pas : sélectionner +500 et −500 afficherait
   * « 0 » et se lirait « rien à payer ». Les deux sous-totaux sont donc toujours montrés.
   */
  const selection = useMemo(() => {
    const rows = pending.filter(s => selected.has(s.id));
    let net = 0, out = 0, inc = 0;
    for (const s of rows) {
      net += s.amount_due_usdt;
      // due > 0 = le joueur nous doit → ça rentre. Inverse de ce que ce bloc supposait avant.
      if (s.amount_due_usdt > 0) inc += s.amount_due_usdt;
      else if (s.amount_due_usdt < 0) out += -s.amount_due_usdt;
    }
    return { rows, net, out, inc, count: rows.length };
  }, [pending, selected]);

  // Une ligne réglée ailleurs (ou délockée) disparaît de `pending` au refresh : on purge la
  // sélection des ids qui n'existent plus, sinon la barre annoncerait un total fantôme.
  useEffect(() => {
    setSelected(prev => {
      const live = new Set(pending.map(s => s.id));
      const next = new Set([...prev].filter(id => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [pending]);

  function toggleOne(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleMany(ids: number[]) {
    setSelected(prev => {
      const next = new Set(prev);
      const allIn = ids.every(id => next.has(id));
      for (const id of ids) { if (allIn) next.delete(id); else next.add(id); }
      return next;
    });
  }
  function togglePlayer(id: number) {
    setOpenPlayers(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleOverdueGroup(key: string) {
    setOpenOverdue(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

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

  async function confirmBulk() {
    const ids = selection.rows.map(s => s.id);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const res = await markPaidBulkAction(ids, bulkHash.trim() || undefined, bulkDate);
      // Échecs rapportés un par un : un « ok » global masquerait un refus (double paiement,
      // règlement délocké entre-temps) et ferait croire que tout est soldé.
      if (res.failures.length > 0) {
        const byId = new Map(selection.rows.map(s => [s.id, s]));
        const detail = res.failures
          .map(f => {
            const s = byId.get(f.id);
            return `· ${s ? `${s.player_name} — ${s.room_label} ${s.week_label ?? ""}` : `#${f.id}`} : ${f.error}`;
          })
          .join("\n");
        alert(`${res.paid} règlement(s) marqué(s) payé(s).\n\n${res.failures.length} refusé(s) :\n${detail}`);
      }
      setBulkOpen(false);
      setSelected(new Set());
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

  /** Ligne d'un règlement réel — partagée par la vue plate et le dépli des groupes. */
  function PendingRow({ s, inset }: { s: HubSettlement; inset?: boolean }) {
    const dir = direction(s.amount_due_usdt);
    const Icon = dir.icon;
    const isSel = selected.has(s.id);
    return (
      <div style={{
        ...rowBase,
        gridTemplateColumns: "20px 88px minmax(110px,1fr) 130px 128px 150px auto",
        background: isSel ? "rgba(245,197,24,0.06)" : inset ? "var(--bg-elevated)" : undefined,
        paddingLeft: inset ? 26 : 14,
      }}>
        <TriCheckbox checked={isSel} onChange={() => toggleOne(s.id)} title="Sélectionner pour un règlement groupé" />

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
          <span style={{ fontSize: 14, fontWeight: 700, color: dir.color, fontVariantNumeric: "tabular-nums" }}>{agencySigned(s.amount_due_usdt)}</span>
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
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26, paddingBottom: selection.count > 0 ? 76 : 0 }}>

      {/* ── En-tête : totaux ─────────────────────────────── */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {/* Ce qui sort est négatif (rouge), ce qui rentre est positif (vert). Les deux tuiles
            lisaient les champs inversés avant la correction du sens (cf. PaymentsTotals). */}
        <Tile
          label="On doit (total)"
          value={`${totals.outgoing_usdt < ZERO ? "" : "−"}${fmt(totals.outgoing_usdt)} USDT`}
          sub="sorties à faire, toutes rooms"
          color="#EF4444"
        />
        <Tile
          label="On nous doit"
          value={`${totals.incoming_usdt < ZERO ? "" : "+"}${fmt(totals.incoming_usdt)} USDT`}
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
          sub={totals.overdue_count > 0 ? `${overdueGroups.length} joueur·room concerné${overdueGroups.length > 1 ? "s" : ""}` : "rien d'oublié ✓"}
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
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {(["grouped", "flat"] as const).map(v => (
              <button key={v} onClick={() => setView(v)} style={{
                ...selectStyle,
                border: view === v ? "1px solid rgba(245,197,24,0.45)" : "1px solid var(--border)",
                background: view === v ? "rgba(245,197,24,0.12)" : "var(--bg-elevated)",
                color: view === v ? "#F5C518" : "var(--text-muted)",
              }}>{v === "grouped" ? "Par joueur" : "Détaillé"}</button>
            ))}
          </div>
          <label style={{ fontSize: 11, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
            Trier par
            <select value={sort} onChange={e => setSort(e.target.value as SortKey)} style={selectStyle}>
              <option value="age">Ancienneté</option>
              <option value="amount">Montant</option>
              <option value="room">Room</option>
            </select>
          </label>
        </div>

        {pending.length === 0 ? (
          <EmptyState>Aucun règlement en attente — tout est payé ✓</EmptyState>
        ) : view === "flat" ? (
          <div style={card}>
            {sortedPending.map(s => <PendingRow key={s.id} s={s} />)}
          </div>
        ) : (
          <div style={card}>
            {sortedGroups.map(g => {
              // Un seul règlement : la ligne réelle suffit, son montant EST le net.
              if (g.count === 1) return <PendingRow key={`solo-${g.player_id}`} s={g.settlements[0]} />;

              const ids = g.settlements.map(s => s.id);
              const allSel = ids.every(id => selected.has(id));
              const someSel = ids.some(id => selected.has(id));
              const nd = netDirection(g.net_usdt);
              const isOpen = openPlayers.has(g.player_id);
              const overdueWeeks = playersWithOverdue.get(g.player_id) ?? 0;
              const compensated = g.incoming_usdt > ZERO && g.outgoing_usdt > ZERO;

              return (
                <div key={g.player_id} style={{ borderBottom: "1px solid var(--border)" }}>
                  {/* En-tête de groupe : le net global sert à décider du virement */}
                  <div
                    onClick={() => togglePlayer(g.player_id)}
                    style={{
                      display: "grid", gridTemplateColumns: "20px 18px minmax(120px,1fr) auto auto",
                      gap: 12, alignItems: "center", padding: "12px 14px", cursor: "pointer",
                      background: someSel ? "rgba(245,197,24,0.05)" : "var(--bg-base)",
                    }}
                  >
                    <TriCheckbox checked={allSel} indeterminate={someSel} onChange={() => toggleMany(ids)}
                      title={`Sélectionner les ${g.count} règlements de ${g.player_name}`} />

                    <span style={{ color: "var(--text-dim)", display: "inline-flex" }}>
                      {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </span>

                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{g.player_name}</span>
                      {g.rooms.map(r => <RoomBadge key={r.label} label={r.label} color={r.color} />)}
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        {g.count} règlements
                      </span>
                      {overdueWeeks > 0 && (
                        <span title="Ce joueur a aussi des semaines jamais réglées : le net ci-contre ne couvre que ses règlements lockés, ce n'est pas son solde réel"
                          style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: "rgba(239,68,68,0.14)", color: "#EF4444", border: "1px solid rgba(239,68,68,0.3)" }}>
                          NET INCOMPLET · +{overdueWeeks} sem. non réglée{overdueWeeks > 1 ? "s" : ""}
                        </span>
                      )}
                    </span>

                    {/* Net compensé toutes rooms — Σ signée de montants déjà figés */}
                    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}
                      title="Solde net toutes rooms compensées, sur les règlements lockés non payés">
                      <span style={{ fontSize: 15, fontWeight: 700, color: nd.color, fontVariantNumeric: "tabular-nums" }}>
                        {Math.abs(g.net_usdt) < ZERO ? "0,00" : agencySigned(g.net_usdt)} USDT
                      </span>
                      <span style={{ fontSize: 10, color: nd.color, opacity: 0.85 }}>
                        net compensé · {nd.label}
                      </span>
                    </span>

                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                      {compensated && (
                        <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}
                          title="Décomposition avant compensation — ce qui sort / ce qui rentre">
                          <span style={{ color: "#10B981" }}>+{fmt(g.incoming_usdt)}</span>
                          {" / "}
                          <span style={{ color: "#EF4444" }}>−{fmt(g.outgoing_usdt)}</span>
                        </span>
                      )}
                      <AgeBadge days={g.oldest_age_days} />
                    </span>
                  </div>

                  {isOpen && (
                    <div>
                      {/* Détail par room — ce qui justifie le net global */}
                      <div style={{
                        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                        padding: "9px 14px 9px 26px", background: "var(--bg-elevated)",
                        borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", fontSize: 11,
                      }}>
                        <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>Par room :</span>
                        {g.rooms.map(r => {
                          const rd = direction(r.net_usdt);
                          return (
                            <span key={r.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                              <RoomBadge label={r.label} color={r.color} />
                              <span style={{ fontWeight: 700, color: rd.color, fontVariantNumeric: "tabular-nums" }}>{agencySigned(r.net_usdt)}</span>
                              <span style={{ color: rd.color, opacity: 0.8 }}>{rd.label.toLowerCase()}</span>
                              <span style={{ color: "var(--text-dim)" }}>({r.count})</span>
                            </span>
                          );
                        })}
                      </div>
                      {g.settlements.map(s => <PendingRow key={s.id} s={s} inset />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 2. Impayés / en retard ───────────────────────── */}
      <section>
        <SectionTitle
          icon={<AlertTriangle size={14} color={overdueGroups.length > 0 ? "#EF4444" : "var(--text-muted)"} />}
          title="Impayés / en retard"
          count={overdueGroups.length}
          tone={overdueGroups.length > 0 ? "#EF4444" : "var(--text)"}
        />

        {overdueGroups.length === 0 ? (
          <EmptyState>Aucune semaine passée laissée de côté — rien d&apos;oublié ✓</EmptyState>
        ) : (
          <>
            <div style={card}>
              {overdueGroups.map(g => {
                const key = `${g.player_id}|${g.room_label}`;
                const critical = g.severity === "critical";
                const accent = critical ? "#EF4444" : "#F59E0B";
                const isOpen = openOverdue.has(key);
                const multi = g.weeks_count > 1;

                return (
                  <div key={key} style={{ borderBottom: "1px solid var(--border)", borderLeft: `3px solid ${accent}` }}>
                    <div
                      onClick={() => multi && toggleOverdueGroup(key)}
                      style={{
                        display: "grid", gridTemplateColumns: "18px 88px minmax(120px,1fr) 150px 170px auto",
                        gap: 12, alignItems: "center", padding: "12px 14px", cursor: multi ? "pointer" : "default",
                      }}
                    >
                      <span style={{ color: "var(--text-dim)", display: "inline-flex" }}>
                        {multi ? (isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : null}
                      </span>

                      <RoomBadge label={g.room_label} color={g.room_color} />

                      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{g.player_name}</span>
                        {g.never_settled && (
                          <span title="Ce joueur n'a JAMAIS été réglé dans cette room" style={{
                            fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4,
                            background: "rgba(239,68,68,0.14)", color: "#EF4444", border: "1px solid rgba(239,68,68,0.3)",
                          }}>JAMAIS RÉGLÉ</span>
                        )}
                      </span>

                      <span style={{ fontSize: 11, fontWeight: 700, color: accent }}>
                        {critical ? "🔴" : "🟠"} {g.weeks_count} semaine{g.weeks_count > 1 ? "s" : ""} en retard
                      </span>

                      {/* Net JOUEUR brut cumulé — PAS un montant dû : aucun action_pct appliqué.
                          Rendu neutre pour ne jamais se lire comme une dette. */}
                      <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}
                        title="Somme des nets joueur bruts (retraits − dépôts) des semaines non réglées, même sens que le montant dû. Reste NEUTRE en couleur : action % pas encore appliqué, le montant dû ne sera connu qu'au règlement.">
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                          {agencySigned(g.net_brut_usdt)}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
                          net joueur brut · {g.tx_count} tx · plus ancienne : {g.oldest_week_label} ({g.max_weeks_late} sem.)
                        </span>
                      </span>

                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                        {g.unconvertible > 0 && (
                          <span title={`${g.unconvertible} tx sans taux de change — exclues du net affiché`}
                            style={{ fontSize: 10, fontWeight: 700, color: "#F59E0B" }}>⚠ {g.unconvertible}</span>
                        )}
                        <a href={`${g.room_base_path}?player=${g.player_id}`} onClick={e => e.stopPropagation()} style={{
                          display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 7,
                          fontSize: 11, fontWeight: 600, background: `${accent}1A`, color: accent,
                          border: `1px solid ${accent}55`, textDecoration: "none", whiteSpace: "nowrap",
                        }}>Aller régler <ExternalLink size={11} /></a>
                      </span>
                    </div>

                    {multi && isOpen && (
                      <div style={{ background: "var(--bg-elevated)", borderTop: "1px solid var(--border)" }}>
                        {g.buckets.map(b => (
                          <div key={b.week_monday} style={{
                            ...rowBase, paddingLeft: 30,
                            gridTemplateColumns: "96px 130px minmax(120px,1fr) auto",
                            borderBottom: "1px solid var(--border)",
                          }}>
                            <WeekChip label={b.week_label} />
                            <span style={{ fontSize: 11, fontWeight: 600, color: b.severity === "critical" ? "#EF4444" : "#F59E0B" }}>
                              {b.weeks_late} sem. de retard
                            </span>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
                              title="Net joueur brut de cette semaine (retraits − dépôts), sans action %">
                              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                                {agencySigned(b.net_usdt)}
                              </span>
                              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>net brut · {b.tx_count} tx</span>
                            </span>
                            <span style={{ fontSize: 10, color: "var(--text-dim)", justifySelf: "end" }}>
                              semaine du {fmtDate(b.week_monday)}
                              {b.unconvertible > 0 && <span style={{ color: "#F59E0B", fontWeight: 700 }}> · ⚠ {b.unconvertible}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8 }}>
              Une semaine n&apos;apparaît ici qu&apos;après {graceDays} jours de délai de grâce — tu as le lundi et le mardi
              pour régler le week-end sans qu&apos;elle passe au rouge. Le net affiché est un net joueur <b>brut</b>
              (retraits − dépôts), laissé en gris volontairement : le montant dû n&apos;existe qu&apos;après
              règlement dans la room, action % appliqué.
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
                      <span style={{ fontSize: 13, fontWeight: 700, color: dir.color, fontVariantNumeric: "tabular-nums" }}>{agencySigned(s.amount_due_usdt)}</span>
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
              <span>Net cumulé : <b style={{ color: Math.abs(paidTotal) < ZERO ? "var(--text-muted)" : paidTotal > 0 ? "#EF4444" : "#10B981" }}>{Math.abs(paidTotal) < ZERO ? "0,00" : agencySigned(paidTotal)} USDT</b> {Math.abs(paidTotal) < ZERO ? "" : paidTotal > 0 ? "sortis" : "rentrés"}</span>
            </div>
          </>
        )}
      </section>

      {/* ── Barre de sélection ───────────────────────────── */}
      {selection.count > 0 && (
        <div style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 60,
          display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
          padding: "12px 22px", background: "var(--bg-elevated)",
          borderTop: "1px solid rgba(245,197,24,0.35)", boxShadow: "0 -8px 30px rgba(0,0,0,0.45)",
        }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#F5C518" }}>
            {selection.count} sélectionné{selection.count > 1 ? "s" : ""}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            net{" "}
            <b style={{ color: netDirection(selection.net).color, fontVariantNumeric: "tabular-nums" }}>
              {Math.abs(selection.net) < ZERO ? "0,00" : agencySigned(selection.net)} USDT
            </b>
            {" — dont "}
            <b style={{ color: "#EF4444" }}>−{fmt(selection.out)} sortants</b>
            {" / "}
            <b style={{ color: "#10B981" }}>+{fmt(selection.inc)} entrants</b>
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setSelected(new Set())} style={{
            display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 7,
            fontSize: 12, fontWeight: 600, background: "none", border: "1px solid var(--border)",
            color: "var(--text-muted)", cursor: "pointer",
          }}><X size={13} /> Vider</button>
          <button onClick={() => { setBulkDate(today()); setBulkHash(""); setBulkOpen(true); }} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8,
            fontSize: 13, fontWeight: 700, background: "rgba(34,197,94,0.16)", color: "var(--green)",
            border: "1px solid rgba(34,197,94,0.4)", cursor: "pointer",
          }}><BadgeCheck size={14} /> Marquer payé ({selection.count})</button>
        </div>
      )}

      {/* ── Modale « marquer payé » (unitaire) ───────────── */}
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
                  {agencySigned(payTarget.amount_due_usdt)} USDT
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

      {/* ── Modale « marquer payé » (groupée) ────────────── */}
      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title={`Marquer ${selection.count} règlement${selection.count > 1 ? "s" : ""} payé${selection.count > 1 ? "s" : ""}`} width={560}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ padding: 14, borderRadius: 8, background: "var(--bg-base)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Net de la sélection</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: netDirection(selection.net).color, fontVariantNumeric: "tabular-nums" }}>
              {Math.abs(selection.net) < ZERO ? "0,00" : agencySigned(selection.net)} USDT
              <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.85 }}> · {netDirection(selection.net).label}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
              dont <b style={{ color: "#EF4444" }}>−{fmt(selection.out)} sortants</b> et <b style={{ color: "#10B981" }}>+{fmt(selection.inc)} entrants</b> —
              chaque règlement est marqué payé <b>individuellement</b>, le net n&apos;est qu&apos;un récapitulatif.
            </div>
          </div>

          <div style={{ maxHeight: 190, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
            {selection.rows.map(s => {
              const dir = direction(s.amount_due_usdt);
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 11px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <RoomBadge label={s.room_label} color={s.room_color} />
                  <span style={{ color: "var(--text)", fontWeight: 600 }}>{s.player_name}</span>
                  <WeekChip label={s.week_label} />
                  <span style={{ marginLeft: "auto", fontWeight: 700, color: dir.color, fontVariantNumeric: "tabular-nums" }}>{agencySigned(s.amount_due_usdt)}</span>
                  <span style={{ fontSize: 10, color: dir.color, opacity: 0.8 }}>{dir.label}</span>
                </div>
              );
            })}
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Date du paiement (appliquée à toute la sélection)</span>
            <input type="date" value={bulkDate} onChange={e => setBulkDate(e.target.value)} style={{ ...inputStyle, fontSize: 13, padding: "9px 12px" }} />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>Hash de la transaction (optionnel, appliqué à toute la sélection)</span>
            <input value={bulkHash} onChange={e => setBulkHash(e.target.value)} placeholder="tx_hash TRON — un seul virement qui solde plusieurs semaines" spellCheck={false}
              style={{ ...inputStyle, fontSize: 12, padding: "9px 12px", fontFamily: "monospace" }} />
          </label>

          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            Les règlements passent en « réglé » ici <b>et</b> dans leurs rooms — ce sont les mêmes lignes.
            Un refus (déjà payé, délocké entre-temps) n&apos;annule pas les autres : le détail te sera listé.
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 2 }}>
            <Btn variant="secondary" onClick={() => setBulkOpen(false)}>Annuler</Btn>
            <Btn variant="primary" onClick={confirmBulk} disabled={busy || selection.count === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(bulkDate)}>
              <BadgeCheck size={14} /> {busy ? "…" : `Confirmer (${selection.count})`}
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
