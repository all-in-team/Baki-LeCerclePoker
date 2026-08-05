"use client";

// Page NEXAPOKER — joueurs, part d'action, réconciliation.
//
// AUCUNE MATH D'ARGENT ICI (invariant #2) : la page affiche des montants calculés
// par le serveur et n'en dérive aucun. Le CALCUL des montants d'action est l'étape 6 ;
// ici on ne fait que stocker et afficher le %.
//
// Rien ne se rattache par approximation : le hint affiché sur une ligne à
// réconcilier vient de resolveRows et n'est jamais appliqué seul.

import { useCallback, useEffect, useMemo, useState } from "react";
import { movementColor, netColor, isZeroAmount } from "@/components/ledger/MovementAmount";

const CARD: React.CSSProperties = {
  background: "#12141C", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: 18,
};
const INPUT: React.CSSProperties = {
  background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8, color: "#E8E8EE", padding: "6px 8px", fontSize: 12,
};
const TH: React.CSSProperties = {
  textAlign: "left", fontSize: 11, color: "#8888A0", fontWeight: 600, padding: "8px 8px", whiteSpace: "nowrap",
};
const TD: React.CSSProperties = { padding: "8px 8px", fontSize: 12, color: "#E8E8EE", whiteSpace: "nowrap" };

type Basis = "gross_rake" | "affiliate_commission";
type MakeupCarry = "carry" | "reset";
type Player = {
  player_id: number; name: string; telegram_handle: string | null; member_id: string | null;
  report_nickname: string | null; action_pct: number; action_since: string | null;
  rakeback_pct: number; rakeback_basis: Basis; rakeback_makeup_carry: MakeupCarry;
  rakeback_since: string | null; rakeback_is_default: boolean;
  weeks_count: number; total_rake: number; total_commission: number; check_ko: number;
  deposited: number; withdrawn: number; net_movements: number; lead_id: number | null;
};
/** L'assiette du % — deux unités différentes, jamais interchangeables. */
const BASIS_LABEL: Record<Basis, string> = {
  gross_rake: "rake brut",
  affiliate_commission: "commission",
};

/** Miroir de WeekResult (lib/funnels/nexa/rakeback-engine.ts) — le moteur fait foi. */
type DetailWeek = {
  week_start: string; status: "ok" | "blocked"; blocked_reason: string | null;
  gross_rake: number; commission: number;
  winloss: number | null; action_pct: number; action_amount: number | null;
};
type PlayerDetail = {
  player_id: number; name: string;
  weeks: DetailWeek[];
  totals: {
    gross_rake: number; commission: number; due: number;
    action_amount: number | null; net_operator: number | null; weeks_missing_winloss: number;
  };
  blocked_weeks: { count: number; week_starts: string[]; gross_rake: number; commission: number };
  warnings: { week_start: string; message: string }[];
  deposited: number; withdrawn: number; net_movements: number;
  net_position: number | null;
};
type Movement = { id: number; type: "deposit" | "withdrawal"; amount: number; currency: string;
                  note: string | null; tx_date: string; created_at: string };
type Unreconciled = {
  row_key: string; member_id: string | null; nickname: string; nickname_key: string;
  weeks: number; total_rake: number; total_commission: number; first_week: string; last_week: string;
  hint_player_id: number | null; hint_player_name: string | null;
};
type Simple = { id: number; name: string; telegram_handle: string | null };
type LeadAnomaly = { member_id: string; lead_id: number; lead_handle: string | null;
                     player_id: number; player_name: string;
                     other_lead_id: number; other_lead_handle: string | null };

const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function NexaPokerClient({ currentWeek, today }: { currentWeek: string; today: string }) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [unrec, setUnrec] = useState<Unreconciled[]>([]);
  const [allPlayers, setAllPlayers] = useState<Simple[]>([]);
  const [anomalies, setAnomalies] = useState<LeadAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Édition de la part d'action : pct + SEMAINE D'EFFET, demandée à chaque fois.
  const [editing, setEditing] = useState<{ player: Player; pct: string; week: string } | null>(null);
  // Édition du rakeback : même modèle, plus l'assiette et le sort du makeup.
  const [editingRb, setEditingRb] = useState<
    { player: Player; pct: string; basis: Basis; carry: MakeupCarry; week: string } | null
  >(null);
  const [adding, setAdding] = useState<{ nickname: string; member_id: string; telegram: string; pct: string; week: string } | null>(null);
  const [linking, setLinking] = useState<{ row: Unreconciled; target: string } | null>(null);
  // Mouvements : saisie d'Hugo, jamais touchée par l'import ni l'extraction.
  const [moving, setMoving] = useState<{ player: Player; kind: "buy_in" | "cash_out"; amount: string; date: string; note: string } | null>(null);
  const [history, setHistory] = useState<{ player: Player; rows: Movement[] } | null>(null);
  // Détail hebdo d'un joueur + brouillons de saisie du win/loss (par semaine).
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [wlDraft, setWlDraft] = useState<Record<string, string>>({});

  // Vue détail : c'est le MOTEUR qui donne la part d'action, jamais l'écran.
  // On stocke ce qu'il renvoie tel quel et on ne recalcule rien côté client.
  const openDetail = useCallback(async (p: Player) => {
    setDetailBusy(true);
    try {
      const j = await (await fetch(`/api/nexapoker/winloss?player_id=${p.player_id}`)).json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error ?? "Détail indisponible." }); return; }
      setDetail(j.detail); setWlDraft({});
    } finally { setDetailBusy(false); }
  }, []);

  const openHistory = useCallback(async (p: Player) => {
    const j = await (await fetch(`/api/nexapoker/movements?player_id=${p.player_id}`)).json();
    if (j.ok) setHistory({ player: p, rows: j.movements });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await (await fetch("/api/nexapoker/players")).json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error }); return; }
      setPlayers(j.players); setUnrec(j.unreconciled); setAllPlayers(j.allPlayers);
      setAnomalies(j.leadAnomalies ?? []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown, okText: (j: any) => string) {
    setBusy(true); setBanner(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error ?? `Échec (HTTP ${res.status}).` }); return false; }
      setBanner({ kind: "ok", text: okText(j) });
      await load();
      return true;
    } catch (e: any) {
      setBanner({ kind: "err", text: e.message ?? String(e) }); return false;
    } finally { setBusy(false); }
  }

  const totals = useMemo(() => ({
    rake: players.reduce((s, p) => s + p.total_rake, 0),
    commission: players.reduce((s, p) => s + p.total_commission, 0),
    alerts: players.reduce((s, p) => s + p.check_ko, 0),
  }), [players]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Le geste hebdomadaire principal, à un clic depuis la room. */}
      <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <a href="#saisie" style={{ textDecoration: "none" }}>
          <span style={{ display: "inline-block", padding: "10px 20px", borderRadius: 10, fontSize: 13,
                         fontWeight: 700, background: "#60A5FA", color: "#0B0D12" }}>
            📷 Saisir la semaine (screenshot)
          </span>
        </a>
        <span style={{ fontSize: 12, color: "#8888A0" }}>
          La saisie est en bas de cette page : dépose le screenshot, la grille se pré-remplit, tu relis, tu enregistres.
        </span>
      </div>

      {/* Conflits de lead : deux leads revendiquent le même joueur. Le funnel n'y
          touche pas — il faut trancher à la main. */}
      {anomalies.length > 0 && (
        <div style={{ ...CARD, borderColor: "rgba(239,68,68,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#F87171", marginBottom: 4 }}>
            ⚠️ {anomalies.length} conflit(s) de lead — deux leads pour un même joueur
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 10 }}>
            Le funnel n'a rien modifié : il ne tranche pas à ta place. Décide quel lead
            correspond réellement au joueur, et corrige le Member ID de l'autre.
          </div>
          <ul style={{ margin: "0 0 0 18px", fontSize: 12, color: "#E8E8EE" }}>
            {anomalies.map(a => (
              <li key={`${a.lead_id}-${a.other_lead_id}`} style={{ marginBottom: 4 }}>
                Member ID <b>{a.member_id}</b> → joueur <b>{a.player_name}</b> (#{a.player_id}), déjà lié au
                lead #{a.other_lead_id}{a.other_lead_handle ? ` (@${a.other_lead_handle})` : ""} ;
                réclamé aussi par le lead #{a.lead_id}{a.lead_handle ? ` (@${a.lead_handle})` : ""}.
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── À réconcilier ─────────────────────────────────────────────── */}
      {unrec.length > 0 && (
        <div style={{ ...CARD, borderColor: "rgba(240,185,11,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#F0B90B", marginBottom: 4 }}>
            ⚠️ {unrec.length} ligne(s) du report à réconcilier
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
            Ces lignes ne sont rattachées à aucun joueur. Une fois rattachées, tout l'historique déjà
            saisi les rejoint — aucune re-saisie.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={TH}>Pseudo report</th><th style={TH}>Member ID</th><th style={TH}>Semaines</th>
              <th style={TH}>Rake</th><th style={TH}>Commission</th><th style={TH}>Période</th><th style={TH} />
            </tr></thead>
            <tbody>
              {unrec.map(u => (
                <tr key={u.row_key} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={{ ...TD, fontWeight: 600 }}>{u.nickname}</td>
                  <td style={TD}>{u.member_id ?? <span style={{ color: "#555568" }}>—</span>}</td>
                  <td style={TD}>{u.weeks}</td>
                  <td style={TD}>{fmt(u.total_rake)}</td>
                  <td style={TD}>{fmt(u.total_commission)}</td>
                  <td style={{ ...TD, color: "#8888A0" }}>{u.first_week} → {u.last_week}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {/* Le hint vient de resolveRows. Il PROPOSE, il n'applique rien. */}
                    {u.hint_player_id !== null && (
                      <span style={{ fontSize: 11, color: "#F0B90B", marginRight: 10 }}
                            title="Candidat proposé d'après le pseudo. Rien n'est rattaché tant que tu ne valides pas.">
                        candidat : {u.hint_player_name}
                      </span>
                    )}
                    <button disabled={busy} onClick={() => setLinking({ row: u, target: String(u.hint_player_id ?? "") })}
                            style={{ ...INPUT, cursor: "pointer", marginRight: 6, borderColor: "rgba(96,165,250,0.4)", color: "#60A5FA" }}>
                      Rattacher
                    </button>
                    <button disabled={busy}
                            onClick={() => setAdding({ nickname: u.nickname, member_id: u.member_id ?? "", telegram: "", pct: "0", week: currentWeek })}
                            style={{ ...INPUT, cursor: "pointer", borderColor: "rgba(16,185,129,0.4)", color: "#34D399" }}>
                      Créer le joueur
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Joueurs ───────────────────────────────────────────────────── */}
      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE" }}>
            Joueurs NEXAPOKER {loading ? "…" : `(${players.length})`}
          </div>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "#8888A0" }}>
            Σ rake {fmt(totals.rake)} · Σ commission {fmt(totals.commission)}
            {totals.alerts > 0 && <span style={{ color: "#F87171" }}> · {totals.alerts} semaine(s) en alerte</span>}
          </span>
          <button disabled={busy}
                  onClick={() => setAdding({ nickname: "", member_id: "", telegram: "", pct: "0", week: currentWeek })}
                  style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#10B981",
                           color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            + Ajouter un joueur
          </button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead><tr>
              {/* Action % en PREMIÈRE colonne après le nom, comme demandé. */}
              <th style={TH}>Joueur</th><th style={{ ...TH, textAlign: "right" }}>Action %</th>
              <th style={{ ...TH, textAlign: "right" }}>RB %</th>
              <th style={TH}>Member ID</th><th style={TH}>@ Telegram</th><th style={TH}>Pseudo report</th>
              <th style={{ ...TH, textAlign: "right" }}>Semaines</th>
              <th style={{ ...TH, textAlign: "right" }}>Rake</th>
              <th style={{ ...TH, textAlign: "right" }}>Commission</th>
              <th style={{ ...TH, textAlign: "right" }}>Buy-ins</th>
              <th style={{ ...TH, textAlign: "right" }}>Cash-outs</th>
              <th style={{ ...TH, textAlign: "right" }}>Net</th>
              <th style={TH}>Mouvements</th>
              <th style={TH} />
            </tr></thead>
            <tbody>
              {players.length === 0 && !loading && (
                <tr><td colSpan={14} style={{ ...TD, color: "#8888A0", padding: 20, textAlign: "center" }}>
                  Aucun joueur rattaché. Utilise « Ajouter un joueur », ou réconcilie une ligne du report.
                </td></tr>
              )}
              {players.map(p => (
                <tr key={p.player_id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={{ ...TD, fontWeight: 600 }}>
                    {p.name}
                    {p.lead_id === null && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "#555568" }} title="Arrivé hors funnel">hors funnel</span>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    <button disabled={busy}
                            onClick={() => setEditing({ player: p, pct: String(p.action_pct), week: currentWeek })}
                            title={p.action_since ? `En vigueur depuis le ${p.action_since}` : "Aucune période enregistrée"}
                            style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.12)",
                                     borderRadius: 6, padding: "3px 10px", cursor: "pointer",
                                     color: p.action_pct > 0 ? "#E8E8EE" : "#8888A0", fontSize: 12, fontWeight: 700 }}>
                      {p.action_pct} %
                    </button>
                  </td>
                  {/* RB % — l'assiette est affichée avec le taux : 40 % du rake brut
                      et 40 % de la commission ne sont pas le même montant. */}
                  <td style={{ ...TD, textAlign: "right" }}>
                    <button disabled={busy}
                            onClick={() => setEditingRb({
                              player: p, pct: String(p.rakeback_pct), basis: p.rakeback_basis,
                              carry: p.rakeback_makeup_carry, week: currentWeek,
                            })}
                            title={p.rakeback_since
                              ? `${p.rakeback_pct} % sur ${BASIS_LABEL[p.rakeback_basis]}, en vigueur depuis le ${p.rakeback_since}`
                              : `Aucune période enregistrée — défaut global (settings) : ${p.rakeback_pct} % sur ${BASIS_LABEL[p.rakeback_basis]}`}
                            style={{ background: "transparent",
                                     border: `1px solid ${p.rakeback_is_default ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.12)"}`,
                                     borderRadius: 6, padding: "3px 10px", cursor: "pointer",
                                     color: p.rakeback_is_default ? "#555568" : "#E8E8EE", fontSize: 12, fontWeight: 700 }}>
                      {p.rakeback_pct} %
                      <span style={{ fontSize: 10, fontWeight: 500, color: "#8888A0", marginLeft: 4 }}>
                        {BASIS_LABEL[p.rakeback_basis]}
                      </span>
                      {p.rakeback_is_default && (
                        <span style={{ fontSize: 9, color: "#555568", marginLeft: 4 }}>déf.</span>
                      )}
                    </button>
                  </td>
                  <td style={TD}>{p.member_id ?? <span style={{ color: "#555568" }}>—</span>}</td>
                  <td style={TD}>{p.telegram_handle ?? <span style={{ color: "#555568" }}>—</span>}</td>
                  <td style={{ ...TD, color: "#8888A0" }}>{p.report_nickname ?? "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{p.weeks_count || "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{fmt(p.total_rake)}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmt(p.total_commission)}</td>
                  <td style={{ ...TD, textAlign: "right", color: movementColor("deposit") }}>
                    {isZeroAmount(p.deposited) ? "—" : fmt(p.deposited)}
                  </td>
                  <td style={{ ...TD, textAlign: "right", color: movementColor("withdrawal") }}>
                    {isZeroAmount(p.withdrawn) ? "—" : fmt(p.withdrawn)}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600,
                               color: netColor(p.net_movements) }}
                      title="Cash-outs − buy-ins. Convention du repo : dépôt rouge, retrait vert — un net négatif est dominé par les dépôts.">
                    {Math.abs(p.net_movements) < 0.005 ? "—" : fmt(p.net_movements)}
                  </td>
                  <td style={TD}>
                    <button disabled={busy} onClick={() => setMoving({ player: p, kind: "buy_in", amount: "", date: today, note: "" })}
                            style={{ ...INPUT, cursor: "pointer", padding: "3px 8px", marginRight: 4, borderColor: "rgba(96,165,250,0.4)", color: "#60A5FA" }}>
                      Buy-in
                    </button>
                    <button disabled={busy} onClick={() => setMoving({ player: p, kind: "cash_out", amount: "", date: today, note: "" })}
                            style={{ ...INPUT, cursor: "pointer", padding: "3px 8px", marginRight: 4, borderColor: "rgba(240,185,11,0.4)", color: "#F0B90B" }}>
                      Cash-out
                    </button>
                    {(p.deposited > 0 || p.withdrawn > 0) && (
                      <button disabled={busy} onClick={() => void openHistory(p)}
                              style={{ ...INPUT, cursor: "pointer", padding: "3px 8px", color: "#8888A0" }}>
                        Historique
                      </button>
                    )}
                    <button disabled={busy || detailBusy} onClick={() => void openDetail(p)}
                            style={{ ...INPUT, cursor: "pointer", padding: "3px 8px", marginLeft: 4,
                                     borderColor: "rgba(16,185,129,0.4)", color: "#10B981" }}>
                      Détail
                    </button>
                  </td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    {p.check_ko > 0 && (
                      <span style={{ color: "#F87171", fontSize: 11 }}
                            title="Semaine(s) dont le recalcul ne retombe pas sur le report">
                        ⚠️ {p.check_ko}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Édition de la part d'action ───────────────────────────────── */}
      {editing && (
        <div style={{ ...CARD, borderColor: "rgba(96,165,250,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>
            Part d'action — {editing.player.name}
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
            La période en cours sera close la semaine précédente et une nouvelle démarrera à la semaine
            choisie. L'historique n'est jamais modifié.
            {editing.player.action_since && <> Période actuelle : {editing.player.action_pct} % depuis le {editing.player.action_since}.</>}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Part d'action %
              <input value={editing.pct} inputMode="decimal" style={{ ...INPUT, width: 80, textAlign: "right" }}
                     onChange={e => setEditing({ ...editing, pct: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              À effet du (lundi)
              <input type="date" value={editing.week} style={INPUT}
                     onChange={e => setEditing({ ...editing, week: e.target.value })} />
            </label>
            <button disabled={busy} onClick={async () => {
              const ok = await post("/api/nexapoker/action-share",
                { player_id: editing.player.player_id, pct: parseFloat(editing.pct.replace(",", ".")), start_week: editing.week },
                j => `Part d'action enregistrée${j.closed_previous ? ` — période précédente close au ${j.closed_previous}` : ""}.`);
              if (ok) setEditing(null);
            }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#10B981", color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Enregistrer
            </button>
            <button onClick={() => setEditing(null)} style={{ ...INPUT, cursor: "pointer", color: "#8888A0" }}>Annuler</button>
          </div>
        </div>
      )}

      {/* ── Détail hebdo d'un joueur + saisie du win/loss ─────────────── */}
      {detail && (
        <div style={{ ...CARD, borderColor: "rgba(16,185,129,0.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE" }}>
              Détail hebdomadaire — {detail.name}
            </div>
            <div style={{ flex: 1 }} />
            <button onClick={() => setDetail(null)} style={{ ...INPUT, cursor: "pointer", color: "#8888A0" }}>
              Fermer
            </button>
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
            La part d'action est calculée par le moteur sur le win/loss saisi ici — jamais déduite du rake.
            Une semaine non saisie reste vide : elle n'est pas comptée comme un zéro.
          </div>

          {detail.warnings.length > 0 && (
            <div style={{ ...CARD, borderColor: "rgba(240,185,11,0.35)", marginBottom: 12, padding: 10 }}>
              {detail.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 11, color: "#F0B90B" }}>⚠️ {w.week_start} — {w.message}</div>
              ))}
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead><tr>
                <th style={TH}>Semaine</th>
                <th style={{ ...TH, textAlign: "right" }}>Rake</th>
                <th style={{ ...TH, textAlign: "right" }}>Commission agence</th>
                <th style={{ ...TH, textAlign: "right" }}>Win/loss (saisie)</th>
                <th style={{ ...TH, textAlign: "right" }}>Action %</th>
                <th style={{ ...TH, textAlign: "right" }}>Part d'action</th>
                <th style={TH} />
              </tr></thead>
              <tbody>
                {detail.weeks.map(w => {
                  const draft = wlDraft[w.week_start];
                  const shown = draft !== undefined ? draft : (w.winloss === null ? "" : String(w.winloss));
                  const save = async (amount: number | null) => {
                    const ok = await post("/api/nexapoker/winloss",
                      { player_id: detail.player_id, week_start: w.week_start, amount },
                      j => j.cleared ? `Win/loss du ${w.week_start} retiré.` : `Win/loss du ${w.week_start} enregistré.`);
                    if (ok) { const p = players.find(x => x.player_id === detail.player_id); if (p) await openDetail(p); }
                  };
                  return (
                    <tr key={w.week_start} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                      <td style={{ ...TD, fontWeight: 600 }}>
                        {w.week_start}
                        {w.status === "blocked" && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: "#F87171" }}
                                title={w.blocked_reason ?? ""}>⚠️ hors calcul</span>
                        )}
                      </td>
                      <td style={{ ...TD, textAlign: "right" }}>{fmt(w.gross_rake)}</td>
                      <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: "#10B981" }}>{fmt(w.commission)}</td>
                      <td style={{ ...TD, textAlign: "right" }}>
                        <input value={shown} inputMode="decimal" placeholder="non saisi"
                               onChange={e => setWlDraft({ ...wlDraft, [w.week_start]: e.target.value })}
                               style={{ ...INPUT, width: 100, textAlign: "right" }} />
                      </td>
                      <td style={{ ...TD, textAlign: "right", color: "#8888A0" }}>{w.action_pct} %</td>
                      <td style={{ ...TD, textAlign: "right", fontWeight: 600,
                                   color: w.action_amount === null ? "#555568" : netColor(w.action_amount) }}>
                        {w.action_amount === null ? "—" : fmt(w.action_amount)}
                      </td>
                      <td style={{ ...TD, textAlign: "right" }}>
                        <button disabled={busy} onClick={() => {
                          const v = parseFloat(shown.replace(",", "."));
                          if (shown.trim() === "" || Number.isNaN(v)) { setBanner({ kind: "err", text: "Montant illisible." }); return; }
                          void save(v);
                        }} style={{ ...INPUT, cursor: "pointer", padding: "3px 8px", color: "#10B981" }}>
                          Enregistrer
                        </button>
                        {w.winloss !== null && (
                          <button disabled={busy} onClick={() => void save(null)}
                                  title="Repasser la semaine en « non saisie » — ce n'est pas la même chose que zéro"
                                  style={{ ...INPUT, cursor: "pointer", padding: "3px 8px", marginLeft: 4, color: "#8888A0" }}>
                            Retirer
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pied : les totaux du moteur, plus la trésorerie qui n'entre pas dans le calcul. */}
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 14, fontSize: 12, color: "#8888A0" }}>
            <span>Commission agence <b style={{ color: "#10B981" }}>{fmt(detail.totals.commission)}</b></span>
            <span>Part d'action{" "}
              <b style={{ color: detail.totals.action_amount === null ? "#555568" : netColor(detail.totals.action_amount) }}>
                {detail.totals.action_amount === null ? "incalculable" : fmt(detail.totals.action_amount)}
              </b>
            </span>
            <span>Buy-ins <b style={{ color: movementColor("deposit") }}>{fmt(detail.deposited)}</b></span>
            <span>Cash-outs <b style={{ color: movementColor("withdrawal") }}>{fmt(detail.withdrawn)}</b></span>
            <span>Net mouvements <b style={{ color: netColor(detail.net_movements) }}>{fmt(detail.net_movements)}</b></span>
            <span style={{ color: "#E8E8EE" }}>
              Position nette{" "}
              <b style={{ color: detail.net_position === null ? "#555568" : netColor(detail.net_position) }}>
                {detail.net_position === null ? "incalculable" : fmt(detail.net_position)}
              </b>
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#555568", marginTop: 6 }}>
            Position nette = part d'action + net des mouvements. Positif = le joueur te doit.
            {detail.totals.weeks_missing_winloss > 0 && (
              <> — <b style={{ color: "#F0B90B" }}>
                {detail.totals.weeks_missing_winloss} semaine(s) sans win/loss
              </b>, donc incalculable tant qu'elles ne sont pas saisies.</>
            )}
            {detail.blocked_weeks.count > 0 && (
              <> {detail.blocked_weeks.count} semaine(s) hors calcul (contrôle en échec),
                 rake exclu {fmt(detail.blocked_weeks.gross_rake)}.</>
            )}
          </div>
        </div>
      )}

      {/* ── Édition du rakeback ───────────────────────────────────────── */}
      {editingRb && (
        <div style={{ ...CARD, borderColor: "rgba(240,185,11,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>
            Rakeback — {editingRb.player.name}
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
            Même modèle que la part d'action : la période en cours sera close la semaine précédente et une
            nouvelle démarrera à la semaine choisie. L'historique n'est jamais modifié — c'est lui qui permet
            de recalculer une semaine passée avec le % qui s'appliquait alors.
            {editingRb.player.rakeback_since
              ? <> Période actuelle : {editingRb.player.rakeback_pct} % sur {BASIS_LABEL[editingRb.player.rakeback_basis]} depuis
                  le {editingRb.player.rakeback_since}.</>
              : <> Aucune période enregistrée : le défaut global de settings s'applique
                  ({editingRb.player.rakeback_pct} % sur {BASIS_LABEL[editingRb.player.rakeback_basis]}).</>}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Rakeback %
              <input value={editingRb.pct} inputMode="decimal" style={{ ...INPUT, width: 80, textAlign: "right" }}
                     onChange={e => setEditingRb({ ...editingRb, pct: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Assiette
              <select value={editingRb.basis} style={{ ...INPUT, cursor: "pointer" }}
                      onChange={e => setEditingRb({ ...editingRb, basis: e.target.value as Basis })}>
                <option value="gross_rake">Rake brut</option>
                <option value="affiliate_commission">Commission d'affiliation</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Makeup en cours
              <select value={editingRb.carry} style={{ ...INPUT, cursor: "pointer" }}
                      onChange={e => setEditingRb({ ...editingRb, carry: e.target.value as MakeupCarry })}>
                <option value="carry">Reporter</option>
                <option value="reset">Purger</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              À effet du (lundi)
              <input type="date" value={editingRb.week} style={INPUT}
                     onChange={e => setEditingRb({ ...editingRb, week: e.target.value })} />
            </label>
            <button disabled={busy} onClick={async () => {
              const ok = await post("/api/nexapoker/rakeback",
                { player_id: editingRb.player.player_id, pct: parseFloat(editingRb.pct.replace(",", ".")),
                  basis: editingRb.basis, makeup_carry: editingRb.carry, start_week: editingRb.week },
                j => `Rakeback enregistré${j.closed_previous ? ` — période précédente close au ${j.closed_previous}` : ""}.`);
              if (ok) setEditingRb(null);
            }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#10B981", color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Enregistrer
            </button>
            <button onClick={() => setEditingRb(null)} style={{ ...INPUT, cursor: "pointer", color: "#8888A0" }}>Annuler</button>
          </div>
          {/* Le choix n'a d'effet qu'au changement d'assiette, et il est loin d'être neutre. */}
          {editingRb.basis !== editingRb.player.rakeback_basis && (
            <div style={{ fontSize: 11, color: "#F0B90B", marginTop: 10 }}>
              Tu changes l'assiette ({BASIS_LABEL[editingRb.player.rakeback_basis]} → {BASIS_LABEL[editingRb.basis]}).
              « Reporter » applique un makeup accumulé sur l'ancienne assiette à la nouvelle — deux unités
              différentes. « Purger » repart de zéro à cette semaine.
            </div>
          )}
        </div>
      )}

      {/* ── Ajout manuel ──────────────────────────────────────────────── */}
      {adding && (
        <div style={{ ...CARD, borderColor: "rgba(16,185,129,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>Ajouter un joueur NEXAPOKER</div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
            Crée le joueur et ses liens d'un coup. Tout l'historique déjà saisi sous ce pseudo ou ce
            Member ID le rejoint immédiatement.
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            {([["nickname", "Pseudo (report)", 160], ["member_id", "Member ID (optionnel)", 130],
               ["telegram", "@ Telegram (optionnel)", 150]] as const).map(([k, label, w]) => (
              <label key={k} style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
                {label}
                <input value={adding[k]} style={{ ...INPUT, width: w }}
                       onChange={e => setAdding({ ...adding, [k]: e.target.value })} />
              </label>
            ))}
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Action %
              <input value={adding.pct} inputMode="decimal" style={{ ...INPUT, width: 70, textAlign: "right" }}
                     onChange={e => setAdding({ ...adding, pct: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              À effet du (lundi)
              <input type="date" value={adding.week} style={INPUT}
                     onChange={e => setAdding({ ...adding, week: e.target.value })} />
            </label>
            <button disabled={busy || adding.nickname.trim() === ""} onClick={async () => {
              const ok = await post("/api/nexapoker/players", {
                nickname: adding.nickname, member_id: adding.member_id || null,
                telegram_handle: adding.telegram || null,
                action_pct: parseFloat(adding.pct.replace(",", ".")) || 0,
                action_start_week: adding.week,
              }, j => `Joueur créé — ${j.backfilled} semaine(s) d'historique rattachée(s).`);
              if (ok) setAdding(null);
            }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#10B981", color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Créer
            </button>
            <button onClick={() => setAdding(null)} style={{ ...INPUT, cursor: "pointer", color: "#8888A0" }}>Annuler</button>
          </div>
        </div>
      )}

      {/* ── Rattachement à un joueur existant ─────────────────────────── */}
      {linking && (
        <div style={{ ...CARD, borderColor: "rgba(96,165,250,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>
            Rattacher « {linking.row.nickname} »
            {linking.row.member_id && <> (Member ID {linking.row.member_id})</>}
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
            {linking.row.weeks} semaine(s) déjà saisie(s) rejoindront ce joueur.
            {linking.row.hint_player_name && (
              <> Candidat proposé d'après le pseudo : <b>{linking.row.hint_player_name}</b> — à confirmer, rien n'est appliqué automatiquement.</>
            )}
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <select value={linking.target} onChange={e => setLinking({ ...linking, target: e.target.value })}
                    style={{ ...INPUT, minWidth: 220 }}>
              <option value="">— choisir un joueur —</option>
              {allPlayers.map(p => (
                <option key={p.id} value={p.id}>{p.name}{p.telegram_handle ? ` (${p.telegram_handle})` : ""}</option>
              ))}
            </select>
            <button disabled={busy || linking.target === ""} onClick={async () => {
              const ok = await post("/api/nexapoker/link",
                { player_id: Number(linking.target), member_id: linking.row.member_id, nickname: linking.row.nickname },
                j => `Rattaché — ${j.backfilled} semaine(s) d'historique reprise(s).`);
              if (ok) setLinking(null);
            }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#60A5FA", color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Rattacher
            </button>
            <button onClick={() => setLinking(null)} style={{ ...INPUT, cursor: "pointer", color: "#8888A0" }}>Annuler</button>
          </div>
        </div>
      )}

      {/* ── Buy-in / cash-out ─────────────────────────────────────────── */}
      {moving && (
        <div style={{ ...CARD, borderColor: moving.kind === "buy_in" ? "rgba(96,165,250,0.35)" : "rgba(240,185,11,0.35)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>
            {moving.kind === "buy_in" ? "Buy-in" : "Cash-out"} — {moving.player.name}
          </div>
          <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
            {moving.kind === "buy_in"
              ? "Le joueur met de l'argent : il finance son action."
              : "Tu paies le joueur."} Montant toujours positif — le sens est porté par le type de
            mouvement. Cette saisie est la tienne : ni l'import ni l'extraction de screenshot n'y touchent.
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Montant (USDT)
              <input value={moving.amount} inputMode="decimal" autoFocus
                     style={{ ...INPUT, width: 110, textAlign: "right" }}
                     onChange={e => setMoving({ ...moving, amount: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Date
              <input type="date" value={moving.date} style={INPUT}
                     onChange={e => setMoving({ ...moving, date: e.target.value })} />
            </label>
            <label style={{ fontSize: 12, color: "#8888A0", display: "flex", gap: 6, alignItems: "center" }}>
              Note (optionnelle)
              <input value={moving.note} style={{ ...INPUT, width: 220 }}
                     onChange={e => setMoving({ ...moving, note: e.target.value })} />
            </label>
            <button disabled={busy} onClick={async () => {
              const ok = await post("/api/nexapoker/movements", {
                player_id: moving.player.player_id, kind: moving.kind,
                amount: parseFloat(moving.amount.replace(",", ".")), tx_date: moving.date,
                note: moving.note || null,
              }, () => `${moving.kind === "buy_in" ? "Buy-in" : "Cash-out"} enregistré pour ${moving.player.name}.`);
              if (ok) setMoving(null);
            }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#10B981",
                        color: "#0B0D12", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              Enregistrer
            </button>
            <button onClick={() => setMoving(null)} style={{ ...INPUT, cursor: "pointer", color: "#8888A0" }}>Annuler</button>
          </div>
        </div>
      )}

      {history && (
        <div style={CARD}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE" }}>
              Mouvements — {history.player.name}
            </div>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: "#8888A0" }}>
              buy-ins {fmt(history.player.deposited)} · cash-outs {fmt(history.player.withdrawn)} ·
              {" "}net <b style={{ color: netColor(history.player.net_movements) }}>
                {fmt(history.player.net_movements)}
              </b>
            </span>
            <button onClick={() => setHistory(null)} style={{ ...INPUT, cursor: "pointer", color: "#8888A0" }}>Fermer</button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={TH}>Date</th><th style={TH}>Type</th>
              <th style={{ ...TH, textAlign: "right" }}>Montant</th><th style={TH}>Note</th><th style={TH} />
            </tr></thead>
            <tbody>
              {history.rows.length === 0 && (
                <tr><td colSpan={5} style={{ ...TD, color: "#8888A0", padding: 14 }}>Aucun mouvement.</td></tr>
              )}
              {history.rows.map(m => (
                <tr key={m.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={TD}>{m.tx_date}</td>
                  <td style={{ ...TD, color: movementColor(m.type) }}>
                    {m.type === "deposit" ? "Buy-in" : "Cash-out"}
                  </td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600, color: movementColor(m.type) }}>{fmt(m.amount)} {m.currency}</td>
                  <td style={{ ...TD, color: "#8888A0" }}>{m.note ?? "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>
                    <button disabled={busy} onClick={async () => {
                      if (!confirm(`Supprimer ce ${m.type === "deposit" ? "buy-in" : "cash-out"} de ${fmt(m.amount)} ?`)) return;
                      setBusy(true);
                      try {
                        const res = await fetch(`/api/nexapoker/movements?id=${m.id}`, { method: "DELETE" });
                        const j = await res.json();
                        if (!j.ok) { setBanner({ kind: "err", text: j.error }); return; }
                        setBanner({ kind: "ok", text: "Mouvement supprimé." });
                        await load(); await openHistory(history.player);
                      } finally { setBusy(false); }
                    }} style={{ ...INPUT, cursor: "pointer", padding: "3px 8px",
                                borderColor: "rgba(239,68,68,0.35)", color: "#F87171" }}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {banner && (
        <div style={{ padding: "10px 14px", borderRadius: 10, fontSize: 12,
                      background: banner.kind === "ok" ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)",
                      border: `1px solid ${banner.kind === "ok" ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"}`,
                      color: banner.kind === "ok" ? "#34D399" : "#F87171" }}>
          {banner.kind === "ok" ? "✅ " : "❌ "}{banner.text}
        </div>
      )}
    </div>
  );
}
