"use client";

// Graph des gains NEXAPOKER — ce que la room rapporte, semaine par semaine.
//
// MÊME TÊTE QUE LES PAGES P&L : le cadre, les onglets Cumulé / Par semaine, les
// couleurs, les axes, l'infobulle et le pied de légende sont repris tels quels de
// NetPnlChart (app/akpoker/pnl/NetPnlChart.tsx), le graph de /kkpoker/pnl et
// /a5nuts/pnl. On ne le RÉUTILISE pas comme composant parce qu'il est câblé sur une
// série unique `cumulative_net` par jour, sans notion de série secondaire ni de
// point marqué — et qu'il sert 4 pages d'argent (akpoker, kkpoker, a5nuts, aks,
// fiche joueur). Le repo a déjà ce précédent : QqpkEvolutionChart est un composant
// de page distinct qui reprend le même vocabulaire visuel.
//
// AUCUNE MATH D'ARGENT ICI (invariant #2). Les semaines arrivent déjà agrégées par
// getNexaAgencyOn (lib/funnels/nexa/agency.ts) : commission = SUM(affiliate_payment),
// rake = SUM(nlh+mtt+plo+spins), check_ko = COUNT(check_ok = 0). Ce composant ne fait
// que cumuler pour la vue « Cumulé » — une somme d'affichage, pas un calcul de dû.

import { useMemo, useState } from "react";
import {
  ComposedChart, Area, BarChart, Bar, Cell, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

const GREEN = "#22C55E", BLUE = "#60A5FA", AMBER = "#F0B90B", GREY = "#64748B";

/** Miroir de AgencyWeek (lib/funnels/nexa/agency.ts) — le serveur fait foi. */
export type NexaChartWeek = {
  week_start: string;
  gross_rake: number;
  commission: number;
  check_ko: number;
  /**
   * RÉSERVÉ au moteur rakeback (étape suivante) : commission − rakeback dû.
   * Absent aujourd'hui — voir SERIES ci-dessous pour le branchement.
   */
  net_operator?: number | null;
};

type SeriesDef = {
  key: string;
  label: string;
  color: string;
  /** Valeur de la semaine, ou null si la donnée n'existe pas encore. */
  value: (w: NexaChartWeek) => number | null;
  /** Affichée à l'ouverture. */
  defaultOn: boolean;
  /** Phrase de l'infobulle du chip — dit ce que le chiffre EST. */
  hint: string;
};

/**
 * Registre des séries — c'est le seul endroit à toucher pour en ajouter une.
 *
 * Quand le moteur rakeback livrera le net par semaine, il suffira de renseigner
 * `net_operator` dans la charge utile de /api/nexapoker/agency et d'ajouter ici :
 *
 *   { key: "net", label: "Net pour moi", color: "#A78BFA", defaultOn: true,
 *     value: w => w.net_operator ?? null,
 *     hint: "Commission encaissée moins le rakeback dû aux joueurs." },
 *
 * Rien d'autre à modifier : le cumul, les barres, l'infobulle, la légende et les
 * chips se construisent tous par itération sur ce tableau. Une série dont `value`
 * ne renvoie que des null se masque d'elle-même (voir `available` plus bas) —
 * elle ne peut donc pas afficher une ligne à zéro là où la donnée manque.
 *
 * Branchement vérifié le 2026-08-05 en ajoutant réellement cette entrée : chip,
 * barres groupées, courbe cumulée, infobulle et légende ont suivi sans autre
 * modification. Éviter en revanche un or/jaune pour cette série — il se confondait
 * avec l'ambre du marquage « contrôle en échec », d'où le passage de ce marquage
 * en hachure (voir le <defs> du mode barres).
 */
const SERIES: SeriesDef[] = [
  {
    key: "commission", label: "Commission encaissée", color: GREEN, defaultOn: true,
    value: w => w.commission,
    hint: "L'argent réellement reçu de la room. Compté même sur une semaine dont le contrôle a échoué.",
  },
  {
    key: "rake", label: "Rake généré", color: BLUE, defaultOn: false,
    value: w => w.gross_rake,
    hint: "Le rake brut produit par les joueurs — l'assiette, pas ta rentrée.",
  },
];

const fmt2 = (n: number) =>
  n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (v: number) =>
  `${v < 0 ? "−" : ""}${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + "k" : Math.abs(v).toFixed(0)}`;

/** Point de la courbe cumulée : ambre quand le contrôle de la semaine a échoué. */
function WeekDot(props: any) {
  const { cx, cy, payload } = props;
  // Pas de point sur les semaines saines : la courbe reste lisible, seul l'écart
  // attire l'œil.
  if (cx === undefined || cy === undefined || !payload?.flagged) return <g key={props.key} />;
  return (
    <circle key={props.key} cx={cx} cy={cy} r={4} fill={AMBER}
            stroke="var(--bg-raised)" strokeWidth={1.5} />
  );
}

export default function NexaRevenueChart({ weeks, currency = "USDT" }: {
  weeks: NexaChartWeek[];
  currency?: string;
}) {
  const [mode, setMode] = useState<"cumul" | "weekly">("weekly");
  const [on, setOn] = useState<Record<string, boolean>>(
    () => Object.fromEntries(SERIES.map(s => [s.key, s.defaultOn])),
  );

  // Une série n'est proposée que si la donnée existe VRAIMENT sur au moins une
  // semaine : une série entièrement nulle serait une ligne à zéro, c'est-à-dire
  // l'affirmation « rien », là où la vérité est « pas encore de donnée ».
  const available = useMemo(
    () => SERIES.filter(s => weeks.some(w => s.value(w) !== null)),
    [weeks],
  );
  const active = available.filter(s => on[s.key]);

  const rows = useMemo(() => {
    const acc: Record<string, number> = {};
    return weeks.map(w => {
      const r: Record<string, any> = {
        week: w.week_start, flagged: w.check_ko > 0, check_ko: w.check_ko,
      };
      for (const s of available) {
        const v = s.value(w) ?? 0;
        acc[s.key] = (acc[s.key] ?? 0) + v;
        r[s.key] = v;
        r[`${s.key}_cum`] = acc[s.key];
      }
      return r;
    });
  }, [weeks, available]);

  const wrap: React.CSSProperties = {
    background: "var(--bg-raised)", border: "1px solid var(--border)",
    borderRadius: 10, padding: "16px 20px 10px",
  };
  const tabBtn = (activeTab: boolean): React.CSSProperties => ({
    padding: "3px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: "pointer",
    background: activeTab ? "rgba(255,255,255,0.07)" : "transparent",
    color: activeTab ? "var(--text)" : "var(--text-dim)",
    border: "1px solid " + (activeTab ? "var(--border)" : "transparent"),
  });

  if (weeks.length === 0) {
    return (
      <div style={{ ...wrap, padding: "22px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
        Gains NEXAPOKER — aucune semaine saisie pour l&apos;instant.
      </div>
    );
  }

  const flaggedCount = rows.filter(r => r.flagged).length;
  // Le grand chiffre = le total de la PREMIÈRE série active, celle qui porte le titre.
  const headline = active[0];
  const headlineTotal = headline
    ? rows.reduce((s, r) => s + (r[headline.key] ?? 0), 0)
    : 0;

  const chipStyle = (s: SeriesDef, isOn: boolean): React.CSSProperties => ({
    padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: "pointer",
    background: isOn ? "rgba(255,255,255,0.06)" : "transparent",
    border: `1px solid ${isOn ? s.color + "66" : "var(--border)"}`,
    color: isOn ? s.color : "var(--text-dim)",
  });

  return (
    <div style={wrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Gains NEXAPOKER par semaine</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {available.length > 1 && (
            <div style={{ display: "flex", gap: 6 }}>
              {available.map(s => (
                <button key={s.key} title={s.hint}
                        onClick={() => setOn(v => ({ ...v, [s.key]: !v[s.key] }))}
                        style={chipStyle(s, !!on[s.key])}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 4, background: "var(--bg-surface)", borderRadius: 8, padding: 2 }}>
            <button onClick={() => setMode("weekly")} style={tabBtn(mode === "weekly")}>Par semaine</button>
            <button onClick={() => setMode("cumul")} style={tabBtn(mode === "cumul")}>Cumulé</button>
          </div>
          {headline && (
            <span style={{ fontSize: 14, fontWeight: 700, color: headline.color }}>
              {fmt2(headlineTotal)} {currency}
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
        {headline
          ? `${headline.label} · ${rows.length} semaine(s) · ${mode === "cumul" ? "cumul depuis la première semaine saisie" : "montant de chaque semaine"}`
          : "Aucune série affichée — active un chiffre ci-dessus."}
      </div>
      {/* Les semaines en échec de contrôle sont AFFICHÉES, jamais retirées : la
          commission a été encaissée. C'est l'écart qui est signalé, pas le chiffre
          qui disparaît — même règle que la vue Agence juste en dessous. */}
      {flaggedCount > 0 && (
        <div style={{ fontSize: 11, color: AMBER, fontWeight: 600, marginBottom: 6 }}>
          ⚠️ {flaggedCount} semaine(s) en échec de contrôle — comptée(s) dans le total,
          {mode === "cumul" ? " marquée(s) d'un point ambre." : " hachurée(s) en ambre."}
        </div>
      )}

      <ResponsiveContainer width="100%" height={190}>
        {mode === "cumul" ? (
          <ComposedChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {active.map(s => (
                <linearGradient key={s.key} id={`nexaFill_${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.20} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <XAxis dataKey="week" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} minTickGap={30} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} width={46} tickFormatter={compact} />
            <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 4" />
            <Tooltip cursor={{ stroke: "var(--border)", strokeWidth: 1 }} content={<ChartTooltip active_={active} cumul currency={currency} />} />
            {active.map(s => (
              <Area key={s.key} type="monotone" dataKey={`${s.key}_cum`} stroke={s.color} strokeWidth={2.5}
                    fill={`url(#nexaFill_${s.key})`} dot={<WeekDot />} activeDot={{ r: 3, fill: s.color }}
                    isAnimationActive={false} />
            ))}
          </ComposedChart>
        ) : (
          <BarChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            {/* Le marquage « contrôle en échec » est une HACHURE, pas une couleur de
                remplacement : une couleur pleine entrerait tôt ou tard en collision
                avec celle d'une série (constaté en ajoutant « Net pour moi » en or,
                indistinguable de l'ambre). La hachure garde la couleur de la série
                — donc le chiffre reste lisible — et signale l'écart par-dessus. */}
            <defs>
              {active.map(s => (
                <pattern key={s.key} id={`nexaFlag_${s.key}`} width={7} height={7}
                         patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                  <rect width={7} height={7} fill={s.color} />
                  <line x1={0} y1={0} x2={0} y2={7} stroke={AMBER} strokeWidth={3.5} />
                </pattern>
              ))}
            </defs>
            <XAxis dataKey="week" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} minTickGap={20} />
            <YAxis tick={{ fontSize: 10, fill: "var(--text-dim)" }} axisLine={false} tickLine={false} width={46} tickFormatter={compact} />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Tooltip cursor={{ fill: "rgba(255,255,255,0.03)" }} content={<ChartTooltip active_={active} currency={currency} />} />
            {/* maxBarSize : sans plafond, recharts répartit toute la largeur entre les
                catégories — à 3 semaines saisies, ça donnait des barres de 308 px,
                des dalles illisibles qui ne ressemblaient plus à un graph. Le plafond
                ne gêne pas le cas nombreux : au-delà d'une quinzaine de semaines, la
                largeur calculée passe sous le plafond et celui-ci devient inerte. */}
            {active.map(s => (
              <Bar key={s.key} dataKey={s.key} radius={[2, 2, 0, 0]} maxBarSize={54} isAnimationActive={false}>
                {rows.map((r, i) => (
                  <Cell key={i} fill={r.flagged ? `url(#nexaFlag_${s.key})` : s.color} fillOpacity={0.85} />
                ))}
              </Bar>
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, flexWrap: "wrap", gap: 6 }}>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--text-dim)", flexWrap: "wrap" }}>
          {active.map(s => (
            <span key={s.key}><span style={{ color: s.color }}>▬</span> {s.label}</span>
          ))}
          <span><span style={{ color: AMBER }}>{mode === "cumul" ? "●" : "▨"}</span> contrôle en échec</span>
        </div>
        {headline && (
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            Σ {headline.label.toLowerCase()} = {fmt2(headlineTotal)} {currency}
          </span>
        )}
      </div>
    </div>
  );
}

/** Infobulle — une ligne par série active, plus le motif de l'ambre s'il y a lieu. */
function ChartTooltip({ active, payload, label, active_, cumul, currency }: {
  active?: boolean; payload?: any[]; label?: any;
  active_: SeriesDef[]; cumul?: boolean; currency: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
      <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}>Semaine du {String(label)}</div>
      {active_.map(s => (
        <div key={s.key} style={{ color: s.color, fontWeight: 600 }}>
          {s.label} : {fmt2(row[cumul ? `${s.key}_cum` : s.key] ?? 0)} {currency}
        </div>
      ))}
      {row.flagged && (
        <div style={{ color: AMBER, fontSize: 11, marginTop: 2 }}>
          ⚠️ contrôle en échec sur {row.check_ko} ligne(s) — montant conservé
        </div>
      )}
      {cumul && <div style={{ color: GREY, fontSize: 10, marginTop: 2 }}>cumul depuis la première semaine</div>}
    </div>
  );
}
