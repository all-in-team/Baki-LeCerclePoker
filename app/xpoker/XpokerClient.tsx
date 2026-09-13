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

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from "recharts";
import Btn from "@/components/Btn";
import { MOVEMENT_COLOR } from "@/components/ledger/MovementAmount";
import type { XpokerDashboard, XpokerDashboardPlayer, XpokerChartWeek } from "@/lib/games/xpoker/dashboard";
import type { PlayerWeek } from "@/lib/games/xpoker/engine";

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
    <span style={{ fontVariantNumeric: "tabular-nums", color: c }}>
      {sign ? signed(n) : fmt(n)} <span style={{ fontSize: 10, color: MUTED }}>chips</span>
      {rate !== null && <span style={{ fontSize: 10, color: MUTED }}> ≈ {sign ? signed(n / rate) : fmt(n / rate)} USD</span>}
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
                <th style={th}>Sem.</th><th style={th}>Win/Lose</th><th style={th}>Rake</th><th style={th}>Part d&apos;action</th><th style={th}>RB joueur</th><th style={th}>Dû net</th><th style={th}>Buy-in / Cash-out</th>
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
      <ImportPlaceholder />
      <Ledger dash={dash} rate={rate} today={today} onChanged={() => router.refresh()} />
      {dash.relink_log.length > 0 && <RelinkLog dash={dash} />}
    </>
  );
}

// ── Graphe ───────────────────────────────────────────────────────────────────

function RevenueChart({ weeks, rate, periodLabel }: { weeks: XpokerChartWeek[]; rate: number | null; periodLabel: string }) {
  const data = useMemo(() => weeks.map(w => ({
    week: w.week_start.slice(5),
    club: w.club_sheet_total,
    // Un null RESTE null : recharts ne dessine pas la barre, il n'invente pas un zéro.
    action: w.action_chips,
    incalculable: w.incalculable, unlinked: w.unlinked_rows, flagged: !w.check_ok,
  })), [weeks]);
  if (weeks.length === 0) return null;
  return (
    <div style={card}>
      <h2 style={h2}>Par semaine — {periodLabel}</h2>
      <p style={help}>Or : règlement club (Total du sheet). Vert/rouge : Σ parts d&apos;action des joueurs (+ = ils me doivent). Deux flux distincts, jamais nettés. Une semaine sans barre verte a un joueur sans deal.</p>
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <BarChart data={data} maxBarSize={38}>
            <XAxis dataKey="week" stroke={MUTED} fontSize={11} />
            <YAxis stroke={MUTED} fontSize={11} tickFormatter={v => `${Math.round(v / 1000)}k`} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Tooltip contentStyle={{ background: "#1a1c22", border: "1px solid var(--border)", fontSize: 12 }}
              formatter={(v: number, name: string) => [`${fmt(v)} chips${rate ? ` ≈ ${fmt(v / rate)} USD` : ""}`, name === "club" ? "Règlement club (sheet)" : "Parts d'action joueurs"]} />
            <Legend formatter={(v: string) => v === "club" ? "Règlement club" : "Parts d'action joueurs"} wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="club" fill={GOLD} radius={[4, 4, 0, 0]} />
            <Bar dataKey="action" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={(d.action ?? 0) >= 0 ? GREEN : RED} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
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
        <td style={td}><Chips n={p.due_chips} rate={rate} sign /><div style={{ fontSize: 10, color: MUTED }}>{dueLabel(p.due_chips)}</div></td>
        <td style={td}>
          <span style={{ color: MOVEMENT_COLOR.deposit }}>{fmt(p.movements.buyin_chips)}</span> / <span style={{ color: MOVEMENT_COLOR.withdrawal }}>{fmt(p.movements.cashout_chips)}</span>
        </td>
      </tr>
      {open && (
        <tr><td colSpan={11} style={{ padding: "12px 14px 18px", borderTop: "1px solid var(--border)", background: "rgba(255,255,255,0.02)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16 }}>
            <WeeksTable weeks={p.weeks} />
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

// ── Deal : valeur actuelle, historique, semaine d'effet, refus nommé ─────────

function DealForm({ p, today, onChanged }: { p: XpokerDashboardPlayer; today: string; onChanged: () => void }) {
  const h = p.deal;
  const [action, setAction] = useState(String(h.current?.action_pct ?? 10));
  const [rb, setRb] = useState(String(h.current?.rb_pct ?? 0));
  const [week, setWeek] = useState(h.earliest_change_week ?? mondayOf(today));
  const [note, setNote] = useState("");
  const [err, setErr] = useState<{ error: string; blocking_weeks: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setErr(null);
    const r = await post("/api/xpoker/deals", { player_id: p.player_id, action_pct: Number(action), rb_pct: Number(rb), start_week: week, note: note || null });
    setBusy(false);
    if (!r.ok) { setErr({ error: r.error ?? "refus", blocking_weeks: (r.blocking_weeks as string[]) ?? [] }); return; }
    setNote(""); onChanged();
  }
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
        <label style={{ fontSize: 11, color: MUTED }}>Action %<br /><input style={{ ...input, width: 70 }} value={action} onChange={e => setAction(e.target.value)} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>RB %<br /><input style={{ ...input, width: 70 }} value={rb} onChange={e => setRb(e.target.value)} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>À partir de la semaine du (lundi)<br /><input type="date" style={input} value={week} onChange={e => setWeek(e.target.value)} /></label>
        <label style={{ fontSize: 11, color: MUTED }}>Note<br /><input style={{ ...input, width: 160 }} value={note} onChange={e => setNote(e.target.value)} /></label>
        <Btn size="sm" onClick={submit} disabled={busy}>{h.current ? "Changer le deal" : "Poser le deal"}</Btn>
      </div>
      {h.earliest_change_week && <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>Première semaine d&apos;effet possible : {h.earliest_change_week} (dernière semaine importée : {h.last_imported_week ?? "aucune"}). Les semaines déjà importées gardent leur taux.</div>}
      {err && (
        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, color: "#FCA5A5" }}>
          {err.error}
          {err.blocking_weeks.length > 0 && <div style={{ marginTop: 4 }}>Semaines qui bloquent : <b>{err.blocking_weeks.join(", ")}</b></div>}
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select style={{ ...input, color: kind === "buyin" ? MOVEMENT_COLOR.deposit : MOVEMENT_COLOR.withdrawal }} value={kind} onChange={e => setKind(e.target.value as "buyin" | "cashout")}>
          <option value="buyin">Buy-in (je crédite son compte)</option>
          <option value="cashout">Cash-out (il me rend des chips)</option>
        </select>
        <select style={input} value={member} onChange={e => setMember(e.target.value)}>
          {active.length === 0 && <option value="">aucun compte actif</option>}
          {active.map(a => <option key={a.member_id} value={a.member_id}>{a.member_id}{a.nickname ? ` · ${a.nickname}` : ""}</option>)}
        </select>
        <input style={{ ...input, width: 110 }} placeholder="chips" value={chips} onChange={e => setChips(e.target.value)} />
        <span style={{ fontSize: 11, color: MUTED }}>{Number.isFinite(n) && n > 0 && rate ? `≈ ${fmt(n / rate)} USD` : ""}</span>
        <input type="date" style={input} value={date} onChange={e => setDate(e.target.value)} />
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

// ── Import hebdo (non câblé) ─────────────────────────────────────────────────

function ImportPlaceholder() {
  return (
    <div style={{ ...card, borderStyle: "dashed" }}>
      <h2 style={h2}>Import hebdo — en attente de la source</h2>
      <p style={{ ...help, margin: 0 }}>
        L&apos;import n&apos;est pas câblé tant que le club n&apos;a pas confirmé : 花順 = club 246579 ? quel classeur fait foi ? format inchangé ?
        Le parseur (libellés, checksum au centime, B20 et U22 stockés tous les deux) et le moteur d&apos;import existent et sont testés sur fixtures.
        La semaine sera toujours une plage de dates confirmée à la main ; le nom d&apos;onglet n&apos;est qu&apos;une suggestion.
      </p>
    </div>
  );
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
          <select style={input} value={importId} onChange={e => { setImportId(e.target.value); const w = pending.find(x => String(x.import_id) === e.target.value); if (w) { setChips(String(Math.abs(w.club_sheet_total))); setDir(w.club_sheet_total >= 0 ? "in" : "out"); } }}>
            <option value="">— semaine —</option>
            {pending.map(w => <option key={w.import_id} value={w.import_id}>{w.week_start} (sheet {signed(w.club_sheet_total)})</option>)}
          </select>
          <select style={input} value={dir} onChange={e => setDir(e.target.value as "in" | "out")}>
            <option value="in">reçu du club (entre)</option><option value="out">versé au club (sort)</option>
          </select>
          <input style={{ ...input, width: 120 }} placeholder="chips reçues" value={chips} onChange={e => setChips(e.target.value)} />
          <input type="date" style={input} value={date} onChange={e => setDate(e.target.value)} />
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
