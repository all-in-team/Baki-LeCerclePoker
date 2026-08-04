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

type Player = {
  player_id: number; name: string; telegram_handle: string | null; member_id: string | null;
  report_nickname: string | null; action_pct: number; action_since: string | null;
  weeks_count: number; total_rake: number; total_commission: number; check_ko: number; lead_id: number | null;
};
type Unreconciled = {
  row_key: string; member_id: string | null; nickname: string; nickname_key: string;
  weeks: number; total_rake: number; total_commission: number; first_week: string; last_week: string;
  hint_player_id: number | null; hint_player_name: string | null;
};
type Simple = { id: number; name: string; telegram_handle: string | null };

const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function NexaPokerClient({ currentWeek }: { currentWeek: string }) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [unrec, setUnrec] = useState<Unreconciled[]>([]);
  const [allPlayers, setAllPlayers] = useState<Simple[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Édition de la part d'action : pct + SEMAINE D'EFFET, demandée à chaque fois.
  const [editing, setEditing] = useState<{ player: Player; pct: string; week: string } | null>(null);
  const [adding, setAdding] = useState<{ nickname: string; member_id: string; telegram: string; pct: string; week: string } | null>(null);
  const [linking, setLinking] = useState<{ row: Unreconciled; target: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await (await fetch("/api/nexapoker/players")).json();
      if (!j.ok) { setBanner({ kind: "err", text: j.error }); return; }
      setPlayers(j.players); setUnrec(j.unreconciled); setAllPlayers(j.allPlayers);
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
              <th style={TH}>Member ID</th><th style={TH}>@ Telegram</th><th style={TH}>Pseudo report</th>
              <th style={{ ...TH, textAlign: "right" }}>Semaines</th>
              <th style={{ ...TH, textAlign: "right" }}>Rake</th>
              <th style={{ ...TH, textAlign: "right" }}>Commission</th>
              <th style={TH} />
            </tr></thead>
            <tbody>
              {players.length === 0 && !loading && (
                <tr><td colSpan={9} style={{ ...TD, color: "#8888A0", padding: 20, textAlign: "center" }}>
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
                  <td style={TD}>{p.member_id ?? <span style={{ color: "#555568" }}>—</span>}</td>
                  <td style={TD}>{p.telegram_handle ?? <span style={{ color: "#555568" }}>—</span>}</td>
                  <td style={{ ...TD, color: "#8888A0" }}>{p.report_nickname ?? "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{p.weeks_count || "—"}</td>
                  <td style={{ ...TD, textAlign: "right" }}>{fmt(p.total_rake)}</td>
                  <td style={{ ...TD, textAlign: "right", fontWeight: 600 }}>{fmt(p.total_commission)}</td>
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
