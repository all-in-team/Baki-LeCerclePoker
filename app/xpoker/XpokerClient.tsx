"use client";

// XPoker Twd — client de la page : graphe, tableau joueurs avec détail INLINE,
// formulaire de deal (valeur actuelle, historique, semaine d'effet, refus nommé
// avec les semaines qui bloquent), comptes (rattacher / archiver / DÉPLACER — R1),
// buy-in / cash-out, réconciliation, grand livre.
//
// AUCUNE MATH D'ARGENT ICI (invariant #2) : tout est calculé côté serveur
// (lib/games/xpoker/{engine,dashboard}.ts) et rendu tel quel. La seule chose
// que ce fichier calcule est un équivalent USD d'AFFICHAGE au taux courant,
// pour un montant que le serveur a déjà chiffré.
//
// Conventions maison : dépôt (buy-in) en ROUGE, retrait (cash-out) en VERT
// (components/ledger/MovementAmount.tsx) ; dû > 0 = « il me doit » vert,
// dû < 0 = « je lui dois » rouge (même sens que /payments) ; trois états, jamais
// de total partiel ; chips toujours accompagnées de leur équivalent USD.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";
import Btn from "@/components/Btn";
import { MOVEMENT_COLOR } from "@/components/ledger/MovementAmount";
import type { XpokerDashboard, XpokerDashboardPlayer, XpokerChartWeek } from "@/lib/games/xpoker/dashboard";
import type { PlayerWeek } from "@/lib/games/xpoker/engine";
import type { WorkbookPreview, TabPreview } from "@/lib/games/xpoker/import";

const GREEN = "#10B981", RED = "#EF4444", GOLD = "#F5C518", DIM = "var(--text-dim)", MUTED = "#8888A0";
const EPS = 0.005;

const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => (n >= 0 ? "+" : "−") + fmt(Math.abs(n));
const pct = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;

/** Chips + équivalent USD, JAMAIS l'un sans l'autre sur un montant qui sert à régler. */
function Chips({ n, rate, sign = false, color }: { n: number | null; rate: number | null; sign?: boolean; color?: string }) {
  if (n === null) return <span style={{ color: MUTED, fontStyle: "italic" }}>incalculable</span>;
  const c = color ?? (sign ? (Math.abs(n) < EPS ? MUTED : n > 0 ? GREEN : RED) : undefined);
  return (
    <span style={{ display: "inline-block", fontVariantNumeric: "tabular-nums", color: c, lineHeight: 1.2 }}>
      {sign ? signed(n) : fmt(n)}
      <span style={{ display: "block", fontSize: 10, color: MUTED, fontWeight: 400 }}>{rate !== null ? `≈ ${sign ? signed(n / rate) : fmt(n / rate)} USD` : "chips"}</span>
    </span>
  );
}

function dueLabel(n: number | null): string {
  if (n === null) return "incalculable";
  if (Math.abs(n) < EPS) return "rien à régler";
  return n > 0 ? "il me doit" : "je lui dois";
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok && j.ok !== false, ...j };
}

const th: React.CSSProperties = { textAlign: "right", padding: "8px 10px", fontSize: 11, color: MUTED, fontWeight: 600, whiteSpace: "nowrap" };
const thL: React.CSSProperties = { ...th, textAlign: "left" };
const td: React.CSSProperties = { textAlign: "right", padding: "8px 10px", fontSize: 13, whiteSpace: "nowrap", borderTop: "1px solid var(--border)" };
const tdL: React.CSSProperties = { ...td, textAlign: "left" };
const input: React.CSSProperties = { background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 6, color: "#E8E8EE", padding: "6px 8px", fontSize: 12 };
const card: React.CSSProperties = { background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginTop: 20 };
const h2: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: "#E8E8EE", margin: "0 0 4px" };
const help: React.CSSProperties = { fontSize: 12, color: MUTED, margin: "0 0 12px" };

export default function XpokerClient({ dash, today, periodLabel }: { dash: XpokerDashboard; today: string; periodLabel: string }) {
  const router = useRouter();
  const rate = dash.rate_now;
  const [open, setOpen] = useState<number | null>(null);

  return (
    <>
      <RevenueChart weeks={dash.weeks} rate={rate} periodLabel={periodLabel} />

      {/* ── Joueurs ─────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h2 style={h2}>Joueurs — {periodLabel}</h2>
            <p style={help}>Somme de tous les comptes du joueur. Part d&apos;action ligne à ligne, RB interne (jamais notifié). Clique une ligne pour le détail.</p>
          </div>
          <span style={{ fontSize: 11, color: MUTED }}>taux courant : {rate === null ? "aucun" : `${rate} chips / USD`}</span>
        </div>
        {dash.players.length === 0 ? (
          <div style={{ color: DIM, fontSize: 13, padding: "12px 0" }}>Aucun joueur XPoker. Ajoute-en un plus bas, ou rattache un Player ID depuis la réconciliation.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                <th style={thL}>Action %</th><th style={thL}>RB %</th><th style={thL}>Joueur</th><th style={thL}>Comptes</th>
                <th style={th}>Sem.</th><th style={th}>Win/Lose (chips)</th><th style={th}>Rake</th><th style={th}>Part d&apos;action</th><th style={th}>RB joueur</th><th style={th}>Dû net</th>
              </tr></thead>
              <tbody>
                {dash.players.map(p => (
                  <PlayerRow key={p.player_id} p={p} rate={rate} today={today} allPlayers={dash.all_players}
                    open={open === p.player_id} onToggle={() => setOpen(open === p.player_id ? null : p.player_id)} onChanged={() => router.refresh()} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <AddPlayerForm today={today} onChanged={() => router.refresh()} />
      </div>

      <Reconciliation dash={dash} onChanged={() => router.refresh()} />
      <ImportPanel onChanged={() => router.refresh()} />
      <Ledger dash={dash} rate={rate} today={today} onChanged={() => router.refresh()} />
      {dash.relink_log.length > 0 && <RelinkLog dash={dash} />}
    </>
  );
}

// ── Graphe ───────────────────────────────────────────────────────────────────

function RevenueChart({ weeks, rate, periodLabel }: { weeks: XpokerChartWeek[]; rate: number | null; periodLabel: string }) {
  const data = useMemo(() => {
    // Hauteur de la barre hachurée « incalculable » : celle du plus grand montant du
    // graphe. Elle ne représente AUCUN montant — c'est un marqueur « données présentes,
    // calcul impossible », distinct d'un vide qui se lirait « pas de données ».
    const yMax = Math.max(1, ...weeks.flatMap(w => [Math.abs(w.club_sheet_total), Math.abs(w.action_chips ?? 0)]));
    return weeks.map(w => ({
      week: w.week_start.slice(5),
      club: w.club_sheet_total,
      // Un null RESTE null : recharts ne dessine pas la barre, il n'invente pas un zéro.
      action: w.action_chips,
      incal: w.action_chips === null ? yMax : null,
      incalculable: w.incalculable, unlinked: w.unlinked_rows, flagged: !w.check_ok,
    }));
  }, [weeks]);
  // Le graphe est CLIENT-ONLY (ResponsiveContainer se mesure au montage) : il
  // n'apparaît qu'après l'hydratation, qui peut prendre plusieurs secondes en dev
  // (constaté : > 5 s au premier chargement, DOM sans SVG puis 8 barres). Pendant
  // ce temps la zone dit qu'elle charge, plutôt que de ressembler à un bug. Le
  // montage est aussi décalé après l'animation d'entrée du template (pageIn).
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 400); return () => clearTimeout(t); }, []);
  if (weeks.length === 0) return null;
  return (
    <div style={card}>
      <h2 style={h2}>Par semaine — {periodLabel}</h2>
      <p style={help}>Or : règlement club (Total du sheet). Vert/rouge : Σ parts d&apos;action des joueurs (+ = ils me doivent). Deux flux distincts, jamais nettés. Une semaine sans barre verte a un joueur sans deal.</p>
      <div style={{ width: "100%", height: 240, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {!ready && <span style={{ fontSize: 12, color: MUTED }}>graphe en cours de chargement…</span>}
        {ready && <ResponsiveContainer width="100%" height={240} debounce={50}>
          <BarChart data={data} barSize={34} barGap={4} barCategoryGap="30%" margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="week" stroke={MUTED} fontSize={11} />
            <YAxis stroke={MUTED} fontSize={11} tickFormatter={v => `${Math.round(v / 1000)}k`} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <defs>
              <pattern id="xpoker-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="rgba(136,136,160,0.10)" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="#8888A0" strokeWidth="1.5" />
              </pattern>
            </defs>
            <Tooltip contentStyle={{ background: "#1a1c22", border: "1px solid var(--border)", fontSize: 12 }}
              formatter={(v: number, name: string, item: { payload?: { incalculable?: number } }) => {
                if (name === "incal") return [`incalculable — ${item.payload?.incalculable ?? "?"} joueur(s) sans deal`, "Parts d'action joueurs"];
                return [`${fmt(v)} chips${rate ? ` ≈ ${fmt(v / rate)} USD` : ""}`, name === "club" ? "Règlement club (sheet)" : "Parts d'action joueurs"];
              }} />
            <Legend payload={[
              { value: "Règlement club", type: "square", color: GOLD },
              { value: "Parts d'action joueurs", type: "square", color: GREEN },
              { value: "incalculable (joueur sans deal)", type: "square", color: "#8888A0" },
            ]} wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="club" fill={GOLD} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            {/* Même stackId : la barre hachurée occupe le créneau de la part d'action quand celle-ci est null. */}
            <Bar dataKey="action" stackId="players" fill={GREEN} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((d, i) => <Cell key={i} fill={(d.action ?? 0) >= 0 ? GREEN : RED} />)}
            </Bar>
            <Bar dataKey="incal" stackId="players" fill="url(#xpoker-hatch)" stroke="#8888A0" strokeWidth={1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: MUTED, marginTop: 6 }}>
        {data.filter(d => d.incalculable > 0).map(d => <span key={d.week}>{d.week} : {d.incalculable} joueur(s) sans deal</span>)}
        {data.filter(d => d.unlinked > 0).map(d => <span key={"u" + d.week} style={{ color: RED }}>{d.week} : {d.unlinked} ligne(s) à réconcilier</span>)}
        {data.filter(d => d.flagged).map(d => <span key={"f" + d.week} style={{ color: GOLD }}>{d.week} : écart acté</span>)}
      </div>
    </div>
  );
}

// ── Ligne joueur + détail inline ─────────────────────────────────────────────

function PlayerRow({ p, rate, today, allPlayers, open, onToggle, onChanged }: {
  p: XpokerDashboardPlayer; rate: number | null; today: string; allPlayers: { id: number; name: string }[];
  open: boolean; onToggle: () => void; onChanged: () => void;
}) {
  const deal = p.deal.current;
  const active = p.accounts.filter(a => a.status === "active");
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer", background: open ? "rgba(255,255,255,0.03)" : undefined }}>
        <td style={{ ...tdL, fontWeight: 700, color: deal ? "#E8E8EE" : RED }}>{deal ? pct(deal.action_pct) : "aucun deal"}</td>
        <td style={{ ...tdL, color: MUTED }}>{deal ? pct(deal.rb_pct) : "—"}</td>
        <td style={{ ...tdL, fontWeight: 600 }}>{p.name}{p.telegram_handle && <span style={{ color: MUTED, fontWeight: 400 }}> {p.telegram_handle}</span>}</td>
        <td style={{ ...tdL, color: MUTED, fontSize: 12 }}>{active.map(a => a.member_id).join(", ") || "—"}{p.accounts.length > active.length && <span> (+{p.accounts.length - active.length} archivé)</span>}</td>
        <td style={td}>{p.weeks_count}{p.incalculable_weeks > 0 && <span style={{ color: RED }} title="semaines sans deal"> ({p.incalculable_weeks} ?)</span>}</td>
        <td style={td}><Chips n={p.winloss_chips} rate={rate} sign /></td>
        <td style={td}><Chips n={p.rake_chips} rate={rate} /></td>
        <td style={td}><Chips n={p.action_chips} rate={rate} sign /></td>
        <td style={td}><Chips n={p.rb_chips} rate={rate} /></td>
        <td style={td}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <Chips n={p.due_chips} rate={rate} sign />
            <span style={{ fontSize: 11, fontWeight: 700, color: p.due_chips === null ? MUTED : Math.abs(p.due_chips) < EPS ? MUTED : p.due_chips > 0 ? GREEN : RED, whiteSpace: "nowrap" }}>{dueLabel(p.due_chips)}</span>
          </div>
        </td>
      </tr>
      {open && (
        <tr><td colSpan={10} style={{ padding: "12px 14px 18px", borderTop: "1px solid var(--border)", background: "rgba(255,255,255,0.02)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
            <WeeksTable weeks={p.weeks} />
            <SettlePanel p={p} rate={rate} onChanged={onChanged} />
            <DealForm p={p} today={today} onChanged={onChanged} />
            <AccountsPanel p={p} allPlayers={allPlayers} onChanged={onChanged} />
            <MovementForm p={p} rate={rate} today={today} onChanged={onChanged} />
          </div>
        </td></tr>
      )}
    </>
  );
}

function WeeksTable({ weeks }: { weeks: PlayerWeek[] }) {
  return (
    <div style={{ gridColumn: "1 / -1" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8EE", marginBottom: 6 }}>Semaines (détail par compte)</div>
      {weeks.length === 0 ? <div style={{ fontSize: 12, color: DIM }}>Aucune semaine importée sur la période.</div> : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={thL}>Semaine</th><th style={thL}>Compte</th><th style={th}>Win/Lose</th><th style={th}>Rake</th><th style={th}>Deal</th><th style={th}>Part d&apos;action</th><th style={th}>RB</th><th style={th}>Dû</th><th style={th}>Taux</th></tr></thead>
            <tbody>{weeks.map(w => (
              <tr key={w.week_start}>
                <td style={tdL}>{w.week_start}{w.import_flagged && <span title="import en écart acté" style={{ color: GOLD }}> ⚠</span>}</td>
                <td style={{ ...tdL, fontSize: 12, color: MUTED }}>{w.accounts.map(a => <div key={a.member_id}>{a.member_id}{a.nickname ? ` · ${a.nickname}` : ""} : {signed(a.winloss_chips)} / {fmt(a.rake_chips)}</div>)}</td>
                <td style={td}><Chips n={w.winloss_chips} rate={w.rate_chips_per_usd} sign /></td>
                <td style={td}><Chips n={w.rake_chips} rate={w.rate_chips_per_usd} /></td>
                <td style={{ ...td, color: w.deal ? MUTED : RED }}>{w.deal ? `${pct(w.deal.action_pct)} / RB ${pct(w.deal.rb_pct)}` : "aucun deal"}</td>
                <td style={td}><Chips n={w.action_chips} rate={w.rate_chips_per_usd} sign /></td>
                <td style={td}><Chips n={w.rb_chips} rate={w.rate_chips_per_usd} /></td>
                <td style={td}><Chips n={w.due_chips} rate={w.rate_chips_per_usd} sign /></td>
                <td style={{ ...td, color: MUTED, fontSize: 11 }}>{w.rate_chips_per_usd} figé</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Règlement (étape 4) : semaines réglables → lock ; payé / délock dans /payments ──

const BLOCK_LABEL: Record<string, string> = {
  no_deal: "incalculable — aucun deal cette semaine",
  flagged: "import en écart — jamais réglable en un clic",
  settled: "déjà réglée",
};

function SettlePanel({ p, rate, onChanged }: { p: XpokerDashboardPlayer; rate: number | null; onChanged: () => void }) {
  const { settleable, blocked, settlements } = p.settle;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState(""); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const chosen = settleable.filter(w => sel.has(w.week_start));
  const due = chosen.reduce((s, w) => s + w.due_chips, 0);
  const dueUsd = chosen.reduce((s, w) => s + w.due_usd, 0);
  async function lock() {
    setBusy(true); setMsg(null);
    const r = await post("/api/xpoker/settle", { player_id: p.player_id, week_starts: [...sel], notes: notes || null });
    setBusy(false);
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    setSel(new Set()); setNotes(""); onChanged();
  }
  return (
    <div style={{ gridColumn: "1 / -1", padding: 12, borderRadius: 8, border: "1px solid rgba(236,72,153,0.35)", background: "rgba(236,72,153,0.05)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8EE", marginBottom: 4 }}>Règlement — en CHIPS, dû net = part d&apos;action − RB, tous comptes confondus</div>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>
        Coche des semaines, verrouille : le montant est recalculé et figé par le moteur. Marquer payé (date réelle du transfert obligatoire) et déverrouiller se font dans <a href="/payments" style={{ color: "#EC4899" }}>Paiements</a>.
        Jamais compensé avec les USDT des autres rooms. L&apos;équivalent USD n&apos;est qu&apos;un affichage.
      </div>
      {settleable.length === 0 && blocked.length === 0 && <div style={{ fontSize: 12, color: DIM }}>Aucune semaine importée.</div>}
      {settleable.length > 0 && (
        <table style={{ borderCollapse: "collapse", marginBottom: 8 }}>
          <thead><tr><th style={thL}></th><th style={thL}>Semaine</th><th style={th}>Win/Lose</th><th style={th}>Deal</th><th style={th}>Part d&apos;action</th><th style={th}>RB</th><th style={th}>Dû</th></tr></thead>
          <tbody>{settleable.map(w => (
            <tr key={w.week_start} style={{ cursor: "pointer" }} onClick={() => setSel(prev => { const n = new Set(prev); n.has(w.week_start) ? n.delete(w.week_start) : n.add(w.week_start); return n; })}>
              <td style={tdL}><input type="checkbox" readOnly checked={sel.has(w.week_start)} /></td>
              <td style={tdL}>{w.week_start}</td>
              <td style={td}><Chips n={w.winloss_chips} rate={w.rate_chips_per_usd} sign /></td>
              <td style={{ ...td, color: MUTED }}>{pct(w.action_pct)} / RB {pct(w.rb_pct)}</td>
              <td style={td}><Chips n={w.action_chips} rate={w.rate_chips_per_usd} sign /></td>
              <td style={td}><Chips n={w.rb_chips} rate={w.rate_chips_per_usd} /></td>
              <td style={td}><Chips n={w.due_chips} rate={w.rate_chips_per_usd} sign /></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {blocked.length > 0 && (
        <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>
          Non réglables : {blocked.map(b => <span key={b.week_start} style={{ marginRight: 10, color: b.reason === "settled" ? MUTED : GOLD }}>{b.week_start} — {BLOCK_LABEL[b.reason]}{b.settlement_id ? ` (#${b.settlement_id})` : ""}</span>)}
        </div>
      )}
      {settleable.length > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>
            {chosen.length === 0
              ? <span style={{ color: MUTED }}>coche une ou plusieurs semaines</span>
              : <>{chosen.length} semaine(s) → <b style={{ fontSize: 15, color: Math.abs(due) < EPS ? MUTED : due > 0 ? GREEN : RED, fontVariantNumeric: "tabular-nums" }}>{signed(due)} chips</b></>}
            {chosen.length > 0 && <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 6, color: Math.abs(due) < EPS ? MUTED : due > 0 ? GREEN : RED }}>{dueLabel(due)}</span>}
            {/* Équivalent aux taux FIGÉS de chaque semaine — le même que portera le règlement. */}
            {chosen.length > 0 && <span style={{ fontSize: 10, color: MUTED }}> (≈ {signed(dueUsd)} USD aux taux figés — affichage)</span>}
          </span>
          <input style={{ ...input, width: 200 }} placeholder="note (optionnel)" value={notes} onChange={e => setNotes(e.target.value)} />
          <Btn size="sm" onClick={lock} disabled={busy || chosen.length === 0}>Verrouiller le règlement</Btn>
        </div>
      )}
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
      {settlements.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: "#E8E8EE", marginBottom: 4 }}>Règlements</div>
          {settlements.map(s => (
            <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "3px 0", borderTop: "1px solid var(--border)" }}>
              <span style={{ color: MUTED }}>#{s.id}</span>
              <span style={{ fontWeight: 700, color: s.status === "paid" ? GREEN : GOLD }}>{s.status === "paid" ? `payé le ${s.paid_date ?? s.paid_at?.slice(0, 10) ?? "?"}` : "verrouillé"}</span>
              <span>{s.weeks.map(w => w.week_start).join(", ")}</span>
              {/* Équivalent FIGÉ au lock (amount_due_usdt), pas le taux courant : la même valeur que /payments. */}
              <span style={{ marginLeft: "auto", display: "inline-block", fontVariantNumeric: "tabular-nums", lineHeight: 1.2, color: Math.abs(s.due_chips) < EPS ? MUTED : s.due_chips > 0 ? GREEN : RED }}>
                {signed(s.due_chips)}<span style={{ display: "block", fontSize: 10, color: MUTED, fontWeight: 400 }}>≈ {signed(s.due_usd)} USD figé</span>
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: Math.abs(s.due_chips) < EPS ? MUTED : s.due_chips > 0 ? GREEN : RED }}>{dueLabel(s.due_chips)}</span>
              {s.notes && <span style={{ color: MUTED, fontSize: 11 }}>— {s.notes}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Deal : valeur actuelle, historique, semaine d'effet, aperçu rétroactif, refus nommé ──

type DealPreview = {
  start_week: string; end_week: string | null;
  weeks: { week_start: string; winloss_chips: number; rake_chips: number;
           before: { action_pct: number; rb_pct: number; action_chips: number; rb_chips: number; due_chips: number } | null;
           after: { action_pct: number; rb_pct: number; action_chips: number; rb_chips: number; due_chips: number } }[];
  total_due_before: number; total_due_after: number; incalculable_before: number; incalculable_after: number;
};
type DealRefusal = { error: string; settled_weeks: { week_start: string; settlement_id: number }[] };

function DealForm({ p, today, onChanged }: { p: XpokerDashboardPlayer; today: string; onChanged: () => void }) {
  const h = p.deal;
  const [action, setAction] = useState(String(h.current?.action_pct ?? 10));
  const [rb, setRb] = useState(String(h.current?.rb_pct ?? 0));
  const [week, setWeek] = useState(h.earliest_change_week ?? mondayOf(today));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<DealRefusal | null>(null);
  const [pending, setPending] = useState<DealPreview | null>(null);   // aperçu d'un changement rétroactif, en attente de confirmation
  const [busy, setBusy] = useState(false);
  // Un champ vidé n'est pas 0 % : NaN, que assertPct refuse côté moteur (Number("") vaudrait 0).
  const num = (s: string) => s.trim() === "" ? NaN : Number(s);
  const body = () => ({ player_id: p.player_id, action_pct: num(action), rb_pct: num(rb), start_week: week, note: note.trim() || null });
  async function submit(confirm: boolean) {
    setBusy(true); setErr(null);
    const r = await post("/api/xpoker/deals", { ...body(), confirm_retroactive: confirm });
    setBusy(false);
    if (!r.ok) {
      if (r.needs_confirmation && r.preview) { setPending(r.preview as DealPreview); return; }
      setPending(null);
      setErr({ error: r.error ?? "refus", settled_weeks: (r.settled_weeks as DealRefusal["settled_weeks"]) ?? [] });
      return;
    }
    setPending(null); setNote(""); onChanged();
  }
  const arrow = (a: string, b: string) => a === b ? <span>{a}</span> : <span><span style={{ color: MUTED }}>{a}</span> → <b>{b}</b></span>;
  const pctOr = (d: { action_pct: number; rb_pct: number } | null) => d ? `${pct(d.action_pct)} / RB ${pct(d.rb_pct)}` : "aucun deal";
  const chipsOr = (n: number | null | undefined) => n === null || n === undefined ? "incalculable" : signed(n);
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8EE", marginBottom: 6 }}>Deal — en POURCENT (10 = 10 %), versionné par semaine</div>
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        {h.current
          ? <>Actuel : <b>action {pct(h.current.action_pct)}</b>, <b>RB {pct(h.current.rb_pct)}</b> depuis la semaine du <b>{h.current.start_week}</b>{h.current.note && <span style={{ color: MUTED }}> — {h.current.note}</span>}</>
          : <span style={{ color: RED }}>Aucun deal : ses semaines sont incalculables tant qu&apos;il n&apos;en a pas. Le premier deal peut couvrir l&apos;historique déjà importé.</span>}
      </div>
      {h.previous.length > 0 && (
        <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>
          Historique : {h.previous.map(d => <div key={d.id}>action {pct(d.action_pct)} / RB {pct(d.rb_pct)} — du {d.start_week} au {d.end_week}{d.note ? ` (${d.note})` : ""}</div>)}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 11, color: MUTED }}>Action %<br /><input style={{ ...input, width: 70 }} value={action} onChange={e => { setAction(e.target.value); setPending(null); }} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>RB %<br /><input style={{ ...input, width: 70 }} value={rb} onChange={e => { setRb(e.target.value); setPending(null); }} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>À partir de la semaine du (lundi)<br /><input type="date" style={input} value={week} onChange={e => { setWeek(e.target.value); setPending(null); }} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>Note{pending ? " (motif, optionnel)" : ""}<br /><input style={{ ...input, width: 160 }} value={note} onChange={e => setNote(e.target.value)} /></label>
        {!pending && <Btn size="sm" onClick={() => submit(false)} disabled={busy}>{h.current ? "Changer le deal" : "Poser le deal"}</Btn>}
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
        {h.earliest_change_week
          ? <>Première semaine d&apos;effet possible : <b>{h.earliest_change_week}</b> (dernière semaine réglée : {h.last_settled_week}, figée). </>
          : <>Aucune semaine réglée : n&apos;importe quel lundi. </>}
        Dernière semaine importée : {h.last_imported_week ?? "aucune"}. Une semaine importée mais non réglée peut être recalculée — après un aperçu avant/après, tracé dans la note.
      </div>
      {pending && (
        <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "rgba(245,197,24,0.08)", border: `1px solid ${GOLD}`, fontSize: 12 }}>
          <div style={{ fontWeight: 700, color: GOLD, marginBottom: 6 }}>
            Changement rétroactif — période écrite du {pending.start_week} au {pending.end_week ?? "…"} : {pending.weeks.length} semaine(s) importée(s) non réglée(s) recalculée(s). Rien n&apos;est écrit tant que tu n&apos;appliques pas.
          </div>
          {pending.weeks.map(w => (
            <div key={w.week_start} style={{ padding: "6px 0", borderTop: "1px solid var(--border)", lineHeight: 1.6 }}>
              <div><b>{w.week_start}</b> <span style={{ color: MUTED }}>— Win/Lose {signed(w.winloss_chips)} · rake {fmt(w.rake_chips)}</span></div>
              <div><span style={{ color: MUTED }}>Deal : </span>{arrow(pctOr(w.before), pctOr(w.after))}</div>
              <div><span style={{ color: MUTED }}>Part d&apos;action : </span>{arrow(chipsOr(w.before?.action_chips), chipsOr(w.after.action_chips))}<span style={{ color: MUTED }}> · RB : </span>{arrow(chipsOr(w.before?.rb_chips), chipsOr(w.after.rb_chips))}</div>
              <div><span style={{ color: MUTED }}>Dû : </span>{arrow(chipsOr(w.before?.due_chips), chipsOr(w.after.due_chips))}</div>
            </div>
          ))}
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--border)", fontWeight: 600 }}>
            Total du dû (toutes semaines importées, réglées comprises) : {arrow(signed(pending.total_due_before), signed(pending.total_due_after))} chips
            {(pending.incalculable_before > 0 || pending.incalculable_after > 0) && <span style={{ color: GOLD }}> — semaines incalculables EXCLUES du total : {pending.incalculable_before} → {pending.incalculable_after}</span>}
            <span style={{ color: MUTED }}> · {dueLabel(pending.total_due_after)}</span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <Btn size="sm" onClick={() => submit(true)} disabled={busy}>Appliquer rétroactivement</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setPending(null)} disabled={busy}>Annuler</Btn>
            <span style={{ fontSize: 11, color: MUTED }}>La trace (date, semaines recalculées, dû avant → après{note.trim() ? ", motif" : ""}) s&apos;écrit dans la note de la période.</span>
          </div>
        </div>
      )}
      {err && (
        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#FCA5A5" }}>
          {err.error}
          {err.settled_weeks.length > 0 && <div style={{ marginTop: 4 }}>Semaines réglées qui bloquent : <b>{err.settled_weeks.map(s => `${s.week_start} (règlement #${s.settlement_id})`).join(", ")}</b></div>}
        </div>
      )}
    </div>
  );
}

// ── Comptes : rattacher, archiver, déplacer (R1) ─────────────────────────────

function AccountsPanel({ p, allPlayers, onChanged }: { p: XpokerDashboardPlayer; allPlayers: { id: number; name: string }[]; onChanged: () => void }) {
  const [memberId, setMemberId] = useState(""); const [nick, setNick] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [relink, setRelink] = useState<{ member_id: string; to: string; reason: string } | null>(null);
  const [relinkErr, setRelinkErr] = useState<{ error: string; blocking: { week_start: string; player_name: string; settlement_id: number }[] } | null>(null);
  async function link() {
    setMsg(null);
    const r = await post("/api/xpoker/accounts", { action: "link", player_id: p.player_id, member_id: memberId, nickname: nick || null });
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    setMemberId(""); setNick(""); onChanged();
  }
  async function archive(id: number) {
    const r = await post("/api/xpoker/accounts", { action: "archive", account_id: id, player_id: p.player_id });
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    onChanged();
  }
  async function doRelink() {
    if (!relink) return;
    setRelinkErr(null);
    const r = await post("/api/xpoker/accounts", { action: "relink", member_id: relink.member_id, to_player_id: Number(relink.to), reason: relink.reason || null });
    if (!r.ok) { setRelinkErr({ error: r.error ?? "refus", blocking: (r.blocking as any[]) ?? [] }); return; }
    setRelink(null); onChanged();
  }
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8EE", marginBottom: 6 }}>Comptes (Player ID) — l&apos;identité forte, jamais le pseudo</div>
      {p.accounts.map(a => (
        <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
          <b style={{ fontVariantNumeric: "tabular-nums" }}>{a.member_id}</b>
          <span style={{ color: MUTED }}>{a.nickname ?? ""}</span>
          <span style={{ color: a.status === "active" ? GREEN : MUTED, fontSize: 11 }}>{a.status === "active" ? "actif" : "archivé"}</span>
          <span style={{ color: MUTED, fontSize: 11 }}>{a.weeks_imported} sem.</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {a.status === "active" && <Btn size="sm" variant="ghost" onClick={() => archive(a.id)}>archiver</Btn>}
            <Btn size="sm" variant="ghost" onClick={() => { setRelink({ member_id: a.member_id, to: "", reason: "" }); setRelinkErr(null); }}>déplacer…</Btn>
          </span>
        </div>
      ))}
      {relink && (
        <div style={{ marginTop: 8, padding: 10, borderRadius: 8, border: "1px solid rgba(245,197,24,0.35)", background: "rgba(245,197,24,0.06)", fontSize: 12 }}>
          <div style={{ marginBottom: 6 }}>Déplacer <b>{relink.member_id}</b> de <b>{p.name}</b> vers :</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select style={input} value={relink.to} onChange={e => setRelink({ ...relink, to: e.target.value })}>
              <option value="">— joueur —</option>
              {allPlayers.filter(x => x.id !== p.player_id).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <input style={{ ...input, width: 220 }} placeholder="motif (obligatoire pour la trace)" value={relink.reason} onChange={e => setRelink({ ...relink, reason: e.target.value })} />
            <Btn size="sm" variant="danger" onClick={doRelink} disabled={!relink.to || !relink.reason.trim()}>Déplacer (toutes ses semaines et mouvements)</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setRelink(null)}>annuler</Btn>
          </div>
          <div style={{ color: MUTED, fontSize: 11, marginTop: 6 }}>Les deux joueurs sont recalculés. Refusé si une semaine concernée est déjà réglée — la liste te sera montrée. Une trace est écrite.</div>
          {relinkErr && (
            <div style={{ marginTop: 6, color: "#FCA5A5" }}>
              {relinkErr.error}
              {relinkErr.blocking.length > 0 && <ul style={{ margin: "4px 0 0 16px" }}>{relinkErr.blocking.map(b => <li key={b.week_start + b.settlement_id}>{b.week_start} — {b.player_name}, règlement #{b.settlement_id}</li>)}</ul>}
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input style={{ ...input, width: 120 }} placeholder="Player ID" value={memberId} onChange={e => setMemberId(e.target.value)} />
        <input style={{ ...input, width: 130 }} placeholder="pseudo (libellé)" value={nick} onChange={e => setNick(e.target.value)} />
        <Btn size="sm" variant="secondary" onClick={link} disabled={!memberId.trim()}>Ajouter ce Player ID</Btn>
      </div>
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

// ── Buy-in / cash-out ────────────────────────────────────────────────────────

function MovementForm({ p, rate, today, onChanged }: { p: XpokerDashboardPlayer; rate: number | null; today: string; onChanged: () => void }) {
  const active = p.accounts.filter(a => a.status === "active");
  const [kind, setKind] = useState<"buyin" | "cashout">("buyin");
  const [member, setMember] = useState(active[0]?.member_id ?? "");
  const [chips, setChips] = useState(""); const [date, setDate] = useState(today); const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  async function submit() {
    setMsg(null);
    const r = await post("/api/xpoker/movements", { kind, chips: Number(chips), occurred_at: date, player_id: p.player_id, member_id: member, note: note || null });
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    setChips(""); setNote(""); onChanged();
  }
  const n = Number(chips);
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8EE", marginBottom: 6 }}>Buy-in / cash-out — trésorerie, jamais dans le règlement</div>
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        <span style={{ color: MOVEMENT_COLOR.deposit }}>Buy-ins (dépôts) {fmt(p.movements.buyin_chips)} chips</span>
        <span style={{ color: MUTED }}> · </span>
        <span style={{ color: MOVEMENT_COLOR.withdrawal }}>Cash-outs (retraits) {fmt(p.movements.cashout_chips)} chips</span>
        <span style={{ color: MUTED }}> · {p.movements.count} mouvement(s)</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...input, width: 240, color: kind === "buyin" ? MOVEMENT_COLOR.deposit : MOVEMENT_COLOR.withdrawal }} value={kind} onChange={e => setKind(e.target.value as "buyin" | "cashout")}>
          <option value="buyin">Buy-in (je crédite son compte)</option>
          <option value="cashout">Cash-out (il me rend des chips)</option>
        </select>
        <select style={{ ...input, width: 200 }} value={member} onChange={e => setMember(e.target.value)}>
          {active.length === 0 && <option value="">aucun compte actif</option>}
          {active.map(a => <option key={a.member_id} value={a.member_id}>{a.member_id}{a.nickname ? ` · ${a.nickname}` : ""}</option>)}
        </select>
        <input style={{ ...input, width: 110 }} placeholder="chips" value={chips} onChange={e => setChips(e.target.value)} />
        <span style={{ fontSize: 11, color: MUTED }}>{Number.isFinite(n) && n > 0 && rate ? `≈ ${fmt(n / rate)} USD` : ""}</span>
        <input type="date" style={{ ...input, width: 150 }} value={date} onChange={e => setDate(e.target.value)} />
        <input style={{ ...input, width: 140 }} placeholder="note" value={note} onChange={e => setNote(e.target.value)} />
        <Btn size="sm" variant="secondary" onClick={submit} disabled={!member || !(n > 0)}>Enregistrer</Btn>
      </div>
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

// ── Ajout manuel d'un joueur ─────────────────────────────────────────────────

function AddPlayerForm({ today, onChanged }: { today: string; onChanged: () => void }) {
  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState(""); const [tg, setTg] = useState(""); const [member, setMember] = useState(""); const [nick, setNick] = useState("");
  const [action, setAction] = useState("10"); const [rb, setRb] = useState("0"); const [week, setWeek] = useState(mondayOf(today));
  const [msg, setMsg] = useState<string | null>(null);
  async function submit() {
    setMsg(null);
    const r = await post("/api/xpoker/players", { name, telegram_handle: tg || null, member_id: member || null, nickname: nick || null, action_pct: action === "" ? null : Number(action), rb_pct: Number(rb || 0), start_week: week });
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    setName(""); setTg(""); setMember(""); setNick(""); setOpenForm(false); onChanged();
  }
  if (!openForm) return <div style={{ marginTop: 12 }}><Btn size="sm" variant="secondary" onClick={() => setOpenForm(true)}>+ Ajouter un joueur</Btn></div>;
  return (
    <div style={{ marginTop: 12, padding: 12, borderRadius: 8, border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8EE", marginBottom: 8 }}>Nouveau joueur XPoker</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...input, width: 160 }} placeholder="nom" value={name} onChange={e => setName(e.target.value)} />
        <input style={{ ...input, width: 130 }} placeholder="@telegram" value={tg} onChange={e => setTg(e.target.value)} />
        <input style={{ ...input, width: 120 }} placeholder="Player ID (optionnel)" value={member} onChange={e => setMember(e.target.value)} />
        <input style={{ ...input, width: 120 }} placeholder="pseudo" value={nick} onChange={e => setNick(e.target.value)} />
        <label style={{ fontSize: 11, color: MUTED }}>Action % <input style={{ ...input, width: 60 }} value={action} onChange={e => setAction(e.target.value)} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>RB % <input style={{ ...input, width: 60 }} value={rb} onChange={e => setRb(e.target.value)} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>dès le <input type="date" style={input} value={week} onChange={e => setWeek(e.target.value)} /></label>
        <Btn size="sm" onClick={submit} disabled={!name.trim()}>Créer</Btn>
        <Btn size="sm" variant="ghost" onClick={() => setOpenForm(false)}>annuler</Btn>
      </div>
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

// ── Réconciliation ───────────────────────────────────────────────────────────

function Reconciliation({ dash, onChanged }: { dash: XpokerDashboard; onChanged: () => void }) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  async function linkTo(member_id: string, player_id: number, nickname: string | null) {
    setMsg(null);
    const r = await post("/api/xpoker/accounts", { action: "link", player_id, member_id, nickname });
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    onChanged();
  }
  async function createFor(member_id: string, nickname: string | null) {
    setMsg(null);
    const name = (newName[member_id] ?? "").trim() || nickname || member_id;
    const r = await post("/api/xpoker/players", { name, member_id, nickname, action_pct: null });
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    onChanged();
  }
  return (
    <div style={card}>
      <h2 style={h2}>Réconciliation — {dash.unlinked.length} Player ID inconnu(s)</h2>
      <p style={help}>Un ID présent dans un import mais rattaché à personne. Les candidats sont PROPOSÉS d&apos;après le pseudo, jamais appliqués : c&apos;est toi qui valides. Un ID archivé qui réapparaît est signalé.</p>
      {dash.unlinked.length === 0 ? <div style={{ fontSize: 13, color: GREEN }}>Rien à réconcilier.</div> : dash.unlinked.map(u => (
        <div key={u.member_id} style={{ padding: "10px 0", borderTop: "1px solid var(--border)", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
          <div style={{ minWidth: 220 }}>
            <b style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{u.member_id}</b>
            <div style={{ color: MUTED }}>R « {u.id_label ?? "—"} » · T « {u.nickname ?? "—"} » · {u.weeks.length} semaine(s) : {u.weeks.join(", ")}</div>
            {u.archived_on && <div style={{ color: GOLD }}>Archivé chez {u.archived_on.name} — rattacher à nouveau le réactive.</div>}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {u.candidates.map(c => <Btn key={c.player_id} size="sm" variant="secondary" onClick={() => linkTo(u.member_id, c.player_id, u.nickname)} title={c.reason}>→ {c.name} <span style={{ color: MUTED, fontWeight: 400 }}>({c.reason})</span></Btn>)}
            {u.archived_on && <Btn size="sm" variant="secondary" onClick={() => linkTo(u.member_id, u.archived_on!.player_id, u.nickname)}>→ réactiver chez {u.archived_on.name}</Btn>}
            <select style={input} value={choice[u.member_id] ?? ""} onChange={e => setChoice({ ...choice, [u.member_id]: e.target.value })}>
              <option value="">— joueur existant —</option>
              {dash.all_players.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <Btn size="sm" variant="secondary" disabled={!choice[u.member_id]} onClick={() => linkTo(u.member_id, Number(choice[u.member_id]), u.nickname)}>Rattacher</Btn>
            <input style={{ ...input, width: 140 }} placeholder={`nouveau joueur (${u.nickname ?? u.member_id})`} value={newName[u.member_id] ?? ""} onChange={e => setNewName({ ...newName, [u.member_id]: e.target.value })} />
            <Btn size="sm" variant="ghost" onClick={() => createFor(u.member_id, u.nickname)}>Créer un joueur avec cet ID</Btn>
          </div>
        </div>
      ))}
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

// ── Import hebdo ─────────────────────────────────────────────────────────────
//
// Dépôt d'un XLSX (classeur entier ou onglet) ou d'un CSV natif → APERÇU de tous
// les onglets, zéro écriture → pour chaque onglet, une plage de dates PROPOSÉE
// (libellé + année suggérée, convention « lundi de règlement = semaine précédente »)
// que Baki CONFIRME → commit d'UN onglet à la fois (le serveur reparse le fichier).
// Checksum KO ⇒ import refusé ; seule sortie : « importer quand même, écart acté »
// avec motif, la semaine reste marquée. Un onglet futur passe comme l'historique :
// le mapping est dérivé des libellés, pas d'adresses.

function ImportPanel({ onChanged }: { onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  async function doPreview() {
    if (!file) return;
    setBusy(true); setMsg(null); setPreview(null);
    const fd = new FormData(); fd.append("file", file); fd.append("action", "preview"); fd.append("year", year);
    const res = await fetch("/api/xpoker/import", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !j.ok) { setMsg(j.error ?? "aperçu impossible"); return; }
    setPreview(j.preview);
  }
  return (
    <div style={card}>
      <h2 style={h2}>Import hebdo — dépose l&apos;export du sheet (XLSX ou CSV)</h2>
      <p style={help}>
        Aperçu d&apos;abord, rien n&apos;est écrit. Puis, onglet par onglet : tu confirmes la plage de dates (le nom d&apos;onglet n&apos;est qu&apos;une suggestion — pas d&apos;année dedans, « 111 » = 1/11 ou 11/1),
        le checksum doit retomber au centime, sinon l&apos;import est refusé. Les Player ID inconnus partent en réconciliation. Le mapping suit les libellés du sheet, pas des cellules.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="file" accept=".xlsx,.xls,.csv" style={{ fontSize: 12, color: MUTED }} onChange={e => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
        <label style={{ fontSize: 11, color: MUTED }}>Année suggérée <input style={{ ...input, width: 70 }} value={year} onChange={e => setYear(e.target.value)} /></label>
        <Btn size="sm" variant="secondary" onClick={doPreview} disabled={!file || busy}>{busy ? "lecture…" : "Aperçu"}</Btn>
        {preview && <span style={{ fontSize: 11, color: MUTED }}>{preview.filename} · {preview.source} · {preview.tabs.length} onglet(s) · sha256 {preview.file_hash.slice(0, 12)}…</span>}
      </div>
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
      {preview && file && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {preview.tabs.map(t => <TabCard key={t.label} t={t} file={file} onChanged={() => { onChanged(); doPreview(); }} />)}
        </div>
      )}
    </div>
  );
}

function TabCard({ t, file, onChanged }: { t: TabPreview; file: File; onChanged: () => void }) {
  const first = t.proposals[0];
  const [ws, setWs] = useState(first?.week_start ?? "");
  const [reason, setReason] = useState(""); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null);
  const we = ws ? addDaysIso(ws, 6) : "";
  const monday = ws ? new Date(ws + "T00:00:00Z").getUTCDay() === 1 : false;
  const b = t.block;
  const ok = !!b && b.checks.checksum_ok;
  async function commit() {
    setBusy(true); setMsg(null);
    const fd = new FormData(); fd.append("file", file); fd.append("action", "commit"); fd.append("tab_label", t.label);
    fd.append("week_start", ws); fd.append("week_end", we); if (reason) fd.append("override_reason", reason); if (note) fd.append("note", note);
    const res = await fetch("/api/xpoker/import", { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !j.ok) { setMsg(j.error ?? "refus"); return; }
    setDone(`importé (#${j.import_id}) — ${j.rows} ligne(s)${j.unlinked?.length ? `, ${j.unlinked.length} Player ID à réconcilier : ${j.unlinked.join(", ")}` : ""}${j.agency?.length ? `, agence : ${j.agency.join(", ")}` : ""}`);
    onChanged();
  }
  const border = t.is_template ? "var(--border)" : t.error ? "rgba(239,68,68,0.4)" : t.already_imported ? "var(--border)" : ok ? "rgba(16,185,129,0.35)" : "rgba(245,197,24,0.45)";
  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 8, padding: "10px 12px", opacity: t.is_template || t.already_imported ? 0.6 : 1 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
        <b style={{ fontSize: 14 }}>onglet « {t.label} »</b>
        {t.is_template && <span style={{ color: MUTED }}>modèle — ignoré</span>}
        {t.error && <span style={{ color: "#FCA5A5" }}>illisible : {t.error}</span>}
        {b && (
          <>
            <span style={{ color: MUTED }}>{b.rows.length} ligne(s) · 反水 {pct(b.params.rb_fraction * 100)} · TAX {pct(b.params.tax_fraction * 100)}</span>
            <span style={{ color: ok ? GREEN : GOLD, fontWeight: 700 }}>
              {ok ? "checksum ✓" : `checksum ✗ (écart ${fmt(b.checks.check_delta)})`} · Total sheet {fmt(b.footer.total)} · recalcul {fmt(b.recompute.total)}
            </span>
            {b.checks.cleared_matches === false && <span style={{ color: GOLD }}>總交收 {fmt(b.cleared ?? 0)} ≠ Total</span>}
            {b.checks.sub_agent_present && <span style={{ color: GOLD }}>sous-agent présent</span>}
            {t.unlinked.length > 0 && <span style={{ color: RED }}>{t.unlinked.length} Player ID inconnu(s) : {t.unlinked.join(", ")}</span>}
          </>
        )}
        {t.already_imported && <span style={{ color: MUTED }}>déjà importé (#{t.already_imported.import_id}, semaine du {t.already_imported.week_start})</span>}
      </div>
      {b && b.warnings.length > 0 && <div style={{ fontSize: 11, color: GOLD, marginTop: 4 }}>{b.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>}
      {b && !t.is_template && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8, fontSize: 12 }}>
          <span style={{ color: MUTED }}>
            {t.ambiguous ? (t.proposals.length > 1 ? `libellé ambigu (${t.proposals.map(p => p.tab_date).join(" ou ")})` : "libellé sans date") : `proposé d'après « ${t.label} » (${first!.tab_day} ${first!.tab_date}, semaine précédente)`}
          </span>
          <label style={{ color: MUTED }}>Semaine du (lundi) <input type="date" style={{ ...input, width: 150 }} value={ws} onChange={e => setWs(e.target.value)} /></label>
          <span style={{ color: monday ? MUTED : RED }}>→ dimanche {we || "?"}{ws && !monday ? " — ce n'est pas un lundi" : ""}</span>
          {!ok && <input style={{ ...input, width: 260 }} placeholder="motif obligatoire : importer quand même, écart acté" value={reason} onChange={e => setReason(e.target.value)} />}
          <input style={{ ...input, width: 160 }} placeholder="note (optionnel)" value={note} onChange={e => setNote(e.target.value)} />
          <Btn size="sm" variant={ok ? "primary" : "danger"} onClick={commit} disabled={busy || !ws || !monday || !!t.already_imported || (!ok && !reason.trim()) || !!done}>
            {ok ? "Importer cette semaine" : "Importer quand même (écart acté)"}
          </Btn>
        </div>
      )}
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
      {done && <div style={{ color: GREEN, fontSize: 12, marginTop: 6 }}>✓ {done}</div>}
    </div>
  );
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z"); if (Number.isNaN(d.getTime())) return ""; d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

// ── Grand livre chips (agence) ───────────────────────────────────────────────

function Ledger({ dash, rate, today, onChanged }: { dash: XpokerDashboard; rate: number | null; today: string; onChanged: () => void }) {
  const [importId, setImportId] = useState<string>(""); const [chips, setChips] = useState(""); const [dir, setDir] = useState<"in" | "out">("in"); const [date, setDate] = useState(today);
  const [msg, setMsg] = useState<string | null>(null);
  const pending = dash.weeks.filter(w => w.club_received === null);
  async function submit() {
    setMsg(null);
    const r = await post("/api/xpoker/movements", { kind: "club_settlement", direction: dir, chips: Number(chips), occurred_at: date, import_id: Number(importId) });
    if (!r.ok) { setMsg(r.error ?? "refus"); return; }
    setChips(""); setImportId(""); onChanged();
  }
  const s = dash.stock;
  return (
    <div style={card}>
      <h2 style={h2}>Grand livre chips — stock agence</h2>
      <p style={help}>Ce que le club m&apos;envoie d&apos;un côté, ce que je redistribue de l&apos;autre. Stock = Σ entrées − Σ sorties. Ce n&apos;est PAS la position d&apos;un joueur : les deux ne s&apos;additionnent jamais.</p>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13, marginBottom: 12 }}>
        <div><span style={{ color: MUTED, fontSize: 11 }}>Stock</span><br /><b><Chips n={s.stock_chips} rate={rate} /></b></div>
        {Object.entries(s.by_kind).map(([k, v]) => (
          <div key={k}><span style={{ color: MUTED, fontSize: 11 }}>{KIND_LABEL[k] ?? k}</span><br />
            <span style={{ color: GREEN }}>+{fmt(v.in)}</span> / <span style={{ color: RED }}>−{fmt(v.out)}</span></div>
        ))}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#E8E8EE", marginBottom: 6 }}>Règlement club reçu — un par semaine importée</div>
      {dash.weeks.length === 0 ? <div style={{ fontSize: 12, color: DIM }}>Aucune semaine importée sur la période.</div> : (
        <table style={{ borderCollapse: "collapse", marginBottom: 10 }}>
          <thead><tr><th style={thL}>Semaine</th><th style={th}>Total (sheet)</th><th style={th}>Reçu (grand livre)</th><th style={thL}>État</th></tr></thead>
          <tbody>{dash.weeks.map(w => (
            <tr key={w.week_start}>
              <td style={tdL}>{w.week_start}{!w.check_ok && <span style={{ color: GOLD }}> ⚠ écart acté</span>}{w.cleared_matches === false && <span style={{ color: GOLD }} title="總交收 ≠ Total dans le sheet"> ⚠ 總交收≠Total</span>}</td>
              <td style={td}><Chips n={w.club_sheet_total} rate={w.rate_chips_per_usd} sign /></td>
              <td style={td}>{w.club_received === null ? <span style={{ color: MUTED }}>non saisi</span> : <Chips n={w.club_received} rate={w.rate_chips_per_usd} sign />}</td>
              <td style={{ ...tdL, fontSize: 11, color: w.club_received === null ? MUTED : Math.abs(w.club_received - w.club_sheet_total) <= EPS ? GREEN : GOLD }}>
                {w.club_received === null ? "à saisir" : Math.abs(w.club_received - w.club_sheet_total) <= EPS ? "= sheet" : "≠ sheet (le reçu fait foi)"}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {pending.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select style={{ ...input, width: 260 }} value={importId} onChange={e => { setImportId(e.target.value); const w = pending.find(x => String(x.import_id) === e.target.value); if (w) { setChips(String(Math.abs(w.club_sheet_total))); setDir(w.club_sheet_total >= 0 ? "in" : "out"); } }}>
            <option value="">— semaine —</option>
            {pending.map(w => <option key={w.import_id} value={w.import_id}>{w.week_start} (sheet {signed(w.club_sheet_total)})</option>)}
          </select>
          <select style={{ ...input, width: 190 }} value={dir} onChange={e => setDir(e.target.value as "in" | "out")}>
            <option value="in">reçu du club (entre)</option><option value="out">versé au club (sort)</option>
          </select>
          <input style={{ ...input, width: 120 }} placeholder="chips reçues" value={chips} onChange={e => setChips(e.target.value)} />
          <input type="date" style={{ ...input, width: 150 }} value={date} onChange={e => setDate(e.target.value)} />
          <Btn size="sm" variant="secondary" onClick={submit} disabled={!importId || !(Number(chips) > 0)}>Enregistrer le montant reçu</Btn>
          <span style={{ fontSize: 11, color: MUTED }}>Le montant que tu confirmes fait foi, pas celui que la feuille calcule.</span>
        </div>
      )}
      {msg && <div style={{ color: "#FCA5A5", fontSize: 12, marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { club_settlement: "Règlements club", buyin: "Buy-ins", cashout: "Cash-outs", action_paid: "Parts d'action payées", rb_paid: "RB versés", adjustment: "Ajustements" };

function RelinkLog({ dash }: { dash: XpokerDashboard }) {
  return (
    <div style={card}>
      <h2 style={h2}>Déplacements de Player ID (trace)</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr><th style={thL}>Quand</th><th style={thL}>Player ID</th><th style={thL}>De → vers</th><th style={thL}>Semaines</th><th style={th}>Mouvements</th><th style={thL}>Motif</th></tr></thead>
        <tbody>{dash.relink_log.map(l => (
          <tr key={l.id}><td style={tdL}>{l.created_at}</td><td style={tdL}>{l.member_id}</td><td style={tdL}>{l.from_name ?? "?"} → {l.to_name ?? "?"}</td><td style={tdL}>{l.weeks.join(", ") || "—"}</td><td style={td}>{l.movements}</td><td style={tdL}>{l.reason ?? "—"}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function mondayOf(iso: string): string {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10);
}
