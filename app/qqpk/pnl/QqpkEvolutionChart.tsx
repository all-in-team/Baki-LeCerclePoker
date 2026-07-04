"use client";

import { useMemo, useState } from "react";
import { ComposedChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import type { QqpkGraphData, QqpkGraphEvent } from "@/lib/queries";

/**
 * Graph d'évolution QQPK — métrique = Part Cercle prévisionnelle + RB manuel
 * (décision Baki : les pics de saisie RB sont voulus, chaque entrée datée = un
 * événement visible). Deux vues :
 *   • CYCLE  : évolution cumulative DANS le cycle sélectionné par les chips de
 *              la page (0 = courant, −n = n-ième cycle réglé par joueur).
 *   • GLOBALE: timeline continue — cycles passés = valeur finale (réel réglé +
 *              RB du cycle) au moment du règlement, cycle courant = courbe vive.
 *
 * ZERO money math ici : chaque point (delta, cumul_player, cumul_all) vient de
 * getQqpkGraphData (moteur + journal, serveur). Ce composant ne fait que choisir
 * quel champ précalculé afficher (filtre joueur = cumul_player, tous = cumul_all).
 * Vérité : le dernier point de la vue cycle (tous joueurs) DOIT == KPI
 * "Total Cercle (prév. + RB)" — sinon bandeau ⚠️ (même pattern que NetPnlChart).
 */

const GREEN = "#22C55E", RED = "#EF4444", GOLD = "#F5C518", GREY = "#64748B", VIOLET = "#8B5CF6";

const KIND_LABEL: Record<QqpkGraphEvent["kind"], string> = {
  seed: "Début de cycle",
  result: "Résultat on-chain",
  rb: "RB manuel (saisie)",
  mains: "Mains (saisie)",
  settle: "Règlement de cycle",
};
const KIND_COLOR: Record<QqpkGraphEvent["kind"], string> = {
  seed: GREY, result: GREEN, rb: GOLD, mains: GREY, settle: VIOLET,
};

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compact = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + "k" : Math.abs(v).toFixed(0)}`;
const fmtTs = (ts: number, withTime = false) =>
  new Date(ts).toLocaleString("fr-FR", withTime
    ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }
    : { day: "numeric", month: "short", timeZone: "Europe/Paris" });

function ChartTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const e: QqpkGraphEvent & { y: number } = payload[0].payload;
  return (
    <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}>{fmtTs(e.ts, true)}</div>
      <div style={{ color: "var(--text)", fontWeight: 600 }}>{e.player_name}</div>
      <div style={{ color: KIND_COLOR[e.kind], fontWeight: 600, fontSize: 11 }}>{KIND_LABEL[e.kind]}</div>
      <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{e.note}</div>
      {e.kind !== "seed" && (
        <div style={{ color: e.delta >= 0 ? GREEN : RED, fontSize: 11 }}>Δ {signed(e.delta)} USDT</div>
      )}
      <div style={{ color: "var(--text)", fontWeight: 700, marginTop: 2 }}>Cumul : {signed(e.y)} USDT</div>
    </div>
  );
}

// Dot coloré par type d'événement (pics RB en or = voulu, règlements en violet).
function EventDot(props: any) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || payload.kind === "seed") return <g key={props.key} />;
  const r = payload.kind === "settle" ? 4 : 3;
  return <circle key={props.key} cx={cx} cy={cy} r={r} fill={KIND_COLOR[payload.kind as QqpkGraphEvent["kind"]]} stroke="var(--bg-raised)" strokeWidth={1} />;
}

export default function QqpkEvolutionChart({
  graph, kpiTotal, cycleView,
}: {
  graph: QqpkGraphData;
  /** KPI "Total Cercle (prév. + RB)" de la page — check de vérité du dernier point. */
  kpiTotal: number;
  cycleView: number;
}) {
  const [view, setView] = useState<"cycle" | "global">("cycle");
  const [playerId, setPlayerId] = useState<number>(0); // 0 = tous (agrégé)

  const events = view === "cycle" ? graph.cycleEvents : graph.globalEvents;

  // Sélection pure de champs précalculés serveur — aucun calcul d'argent ici.
  const data = useMemo(() => {
    const scoped = playerId === 0 ? events : events.filter((e) => e.player_id === playerId);
    return scoped.map((e) => ({ ...e, y: playerId === 0 ? e.cumul_all : e.cumul_player }));
  }, [events, playerId]);

  const wrap: React.CSSProperties = { background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px 10px", marginBottom: 28 };
  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "3px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
    background: active ? "rgba(255,255,255,0.07)" : "transparent",
    color: active ? "var(--text)" : "var(--text-dim)", border: "1px solid " + (active ? "var(--border)" : "transparent"),
  });

  const header = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Évolution Part Cercle prévisionnelle (+ RB manuel)</span>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <select
          value={playerId}
          onChange={(e) => setPlayerId(Number(e.target.value))}
          style={{ background: "var(--bg-surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 7, fontSize: 11, padding: "4px 8px", outline: "none" }}
        >
          <option value={0}>Tous les joueurs (agrégé)</option>
          {graph.players.map((p) => <option key={p.player_id} value={p.player_id}>{p.player_name}</option>)}
        </select>
        <div style={{ display: "flex", gap: 4, background: "var(--bg-surface)", borderRadius: 8, padding: 2 }}>
          <button onClick={() => setView("cycle")} style={tabBtn(view === "cycle")}>
            {cycleView === 0 ? "Vue cycle (courant)" : `Vue cycle (−${cycleView})`}
          </button>
          <button onClick={() => setView("global")} style={tabBtn(view === "global")}>Vue globale</button>
        </div>
      </div>
    </div>
  );

  if (data.length === 0) {
    return (
      <div style={{ ...wrap, paddingBottom: 16 }}>
        {header}
        <div style={{ padding: "18px 0 8px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
          Aucune donnée datée pour cette vue — la courbe se construit à partir des transactions on-chain et des saisies (mains, RB) journalisées.
        </div>
      </div>
    );
  }

  const last = data[data.length - 1].y;
  const color = last >= 0 ? GREEN : RED;
  // Vérité : vue cycle + tous joueurs → dernier cumul == KPI Total Cercle (prév. + RB).
  const truthApplies = view === "cycle" && playerId === 0;
  const coherent = !truthApplies || Math.abs(last - kpiTotal) < 0.01;
  const settleTs = view === "global" ? [...new Set(data.filter((e) => e.kind === "settle").map((e) => e.ts))] : [];

  return (
    <div style={wrap}>
      {header}
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
        {view === "cycle"
          ? "Cumul dans le cycle, par temps d'entrée : chaque point = un événement daté (tx on-chain, saisie RB, mains)."
          : "Timeline continue tous cycles : cycles passés = valeur finale au règlement (réel + RB), cycle courant = courbe vive."}
      </div>
      {!coherent && (
        <div style={{ fontSize: 11, color: RED, fontWeight: 600, marginBottom: 6 }}>
          ⚠️ Écart courbe ({signed(last)} USDT) vs KPI Total Cercle prév. + RB ({signed(kpiTotal)} USDT)
        </div>
      )}

      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="qqpkEvoFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.20} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time"
            tickFormatter={(t: number) => fmtTs(t)}
            tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} minTickGap={40}
          />
          <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} width={46} tickFormatter={compact} />
          <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
          {settleTs.map((ts) => (
            <ReferenceLine key={ts} x={ts} stroke={VIOLET} strokeOpacity={0.35} strokeDasharray="3 4" />
          ))}
          <Tooltip cursor={{ stroke: "var(--border)", strokeWidth: 1 }} content={<ChartTooltip />} />
          <Area
            type="stepAfter" dataKey="y" stroke={color} strokeWidth={2}
            fill="url(#qqpkEvoFill)" dot={<EventDot />} activeDot={{ r: 4, fill: color }} isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, flexWrap: "wrap", gap: 6 }}>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--text-dim)" }}>
          <span><span style={{ color: GREEN }}>●</span> résultat on-chain</span>
          <span><span style={{ color: GOLD }}>●</span> saisie RB</span>
          <span><span style={{ color: GREY }}>●</span> mains</span>
          <span><span style={{ color: VIOLET }}>●</span> règlement{view === "global" ? " (séparateur de cycle)" : ""}</span>
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color }}>{signed(last)} USDT{truthApplies && coherent ? " · = KPI ✓" : ""}</span>
      </div>
    </div>
  );
}
