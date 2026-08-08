"use client";

import { useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import StatCard from "@/components/StatCard";
import type { RichAdsStats, RichAdsBreakdownRow } from "@/lib/richads";

const CARD: React.CSSProperties = {
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.07)",
  background: "linear-gradient(180deg, #13141C, #0D0E14)",
};

type DimKey = "cre" | "sid" | "app" | "geo";

const DIMS: { key: DimKey; label: string; hint: string }[] = [
  { key: "cre", label: "Créa", hint: "[CREATIVE_ID] — l'id RichAds, ou son nom si la correspondance est renseignée" },
  { key: "sid", label: "Publisher", hint: "[TG_PUB_ID] — qui vend l'emplacement" },
  { key: "app", label: "Mini app", hint: "[TG_APP_ID] — où la pub s'affiche. Une même app peut être vendue par plusieurs publishers" },
  { key: "geo", label: "Pays", hint: "[COUNTRY] — nom de pays, pas un code ISO" },
];

function fmtInt(n: number): string {
  return n.toLocaleString("fr-FR");
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function flagColor(p: number): string {
  if (p >= 30) return "#EF4444";
  if (p >= 10) return "#F5C518";
  return "#8888A0";
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      borderRadius: 12, padding: "9px 13px",
      border: "1px solid rgba(255,255,255,0.12)",
      background: "linear-gradient(180deg, #13141C, #0D0E14)",
      boxShadow: "0 16px 32px -8px rgba(0,0,0,0.6)",
    }}>
      <div style={{ fontSize: 10, color: "#555568", marginBottom: 4, letterSpacing: "0.08em" }}>{label}</div>
      {payload.map(r => (
        <div key={r.name} style={{
          fontSize: 11.5, fontWeight: 600, color: r.color,
          display: "flex", justifyContent: "space-between", gap: 14,
          fontVariantNumeric: "tabular-nums",
        }}>
          <span>{r.name}</span><span>{fmtInt(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function BreakdownTable({ rows, dimLabel }: { rows: RichAdsBreakdownRow[]; dimLabel: string }) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "#555568", fontSize: 12.5 }}>
        Aucun clic enregistré pour cette dimension.
      </div>
    );
  }

  const th: React.CSSProperties = {
    padding: "12px 12px", fontSize: 10.5, fontWeight: 700, color: "#555568",
    textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
  };
  const td: React.CSSProperties = {
    padding: "11px 12px", fontSize: 12.5, color: "#E8E8EE",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>{dimLabel}</th>
            <th style={{ ...th, textAlign: "right" }}>Clics bruts</th>
            <th style={{ ...th, textAlign: "right" }}>Clics uniques</th>
            <th style={{ ...th, textAlign: "right" }}>Flagués</th>
            <th style={{ ...th, textAlign: "right" }}>% flagués</th>
            <th style={{ ...th, textAlign: "right" }}>Coût cumulé</th>
            <th style={{ ...th, textAlign: "right" }}>Coût / clic unique</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>
                {r.label}
                {r.label !== r.key && (
                  <code style={{ marginLeft: 7, fontSize: 10.5, color: "#555568" }}>{r.key}</code>
                )}
                {r.key === "unknown" && (
                  <span title="cre vide ou macro non substituée dans la campagne RichAds" style={{
                    marginLeft: 7, fontSize: 10, padding: "2px 6px", borderRadius: 4,
                    background: "rgba(245,197,24,0.12)", color: "#F5C518", fontWeight: 700,
                  }}>à vérifier</span>
                )}
              </td>
              <td style={{ ...td, textAlign: "right" }}>{fmtInt(r.clicks)}</td>
              <td style={{ ...td, textAlign: "right", color: "#10B981", fontWeight: 600 }}>{fmtInt(r.unique)}</td>
              <td style={{ ...td, textAlign: "right", color: "#8888A0" }}>{fmtInt(r.flagged)}</td>
              <td style={{ ...td, textAlign: "right", color: flagColor(r.flaggedPct), fontWeight: 600 }}>
                {r.flaggedPct.toFixed(1)} %
              </td>
              <td style={{ ...td, textAlign: "right" }}>{fmtUsd(r.cost)}</td>
              <td style={{ ...td, textAlign: "right", color: "#8888A0" }}>
                {r.unique > 0 ? fmtUsd(r.cost / r.unique) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RichAdsClient({ stats, destConfigured }: {
  stats: RichAdsStats;
  destConfigured: boolean;
}) {
  const [dim, setDim] = useState<DimKey>("cre");
  const { totals, byDay } = stats;

  const rowsByDim: Record<DimKey, RichAdsBreakdownRow[]> = {
    cre: stats.byCre, sid: stats.bySid, app: stats.byApp, geo: stats.byGeo,
  };
  const active = DIMS.find(d => d.key === dim)!;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {!destConfigured && (
        <div style={{
          ...CARD, padding: "14px 18px", borderColor: "rgba(239,68,68,0.35)",
          fontSize: 13, color: "#EF4444", fontWeight: 600,
        }}>
          RICHADS_DEST_URL n&apos;est pas configuré — /go répond 503 et le trafic acheté n&apos;arrive nulle part.
          Renseigner la variable avant de lancer la campagne.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
        <StatCard label="Clics bruts" value={fmtInt(totals.clicks)}
          sub={totals.firstAt ? `depuis le ${totals.firstAt.slice(0, 10)}` : "aucun clic"} />
        <StatCard label="Clics uniques" value={fmtInt(totals.unique)} accent="green"
          sub={`${(100 - totals.flaggedPct).toFixed(1)} % du brut`} />
        <StatCard label="Flagués" value={`${totals.flaggedPct.toFixed(1)} %`}
          accent={totals.flaggedPct >= 30 ? "red" : totals.flaggedPct >= 10 ? "gold" : "neutral"}
          sub={`${fmtInt(totals.flagged)} clic(s) marqué(s)`} />
        <StatCard label="Coût cumulé" value={fmtUsd(totals.cost)} accent="gold"
          sub={totals.unique > 0 ? `${fmtUsd(totals.cost / totals.unique)} / clic unique` : "—"} />
      </div>

      <div style={{ ...CARD, padding: "16px 20px", display: "flex", flexWrap: "wrap", gap: 26 }}>
        {[
          { k: "duplicate", n: totals.duplicate, why: "click_id déjà vu — rejeu du même clic" },
          { k: "suspect_ip", n: totals.suspectIp, why: "plus de 10 clics depuis la même IP en 1 h" },
          { k: "no_ua", n: totals.noUa, why: "user-agent vide ou signature automatisée" },
        ].map(f => (
          <div key={f.k} title={f.why} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, color: "#555568",
              textTransform: "uppercase", letterSpacing: "0.08em",
            }}>{f.k}</span>
            <span style={{ fontSize: 19, fontWeight: 700, color: f.n > 0 ? "#F5C518" : "#555568", fontVariantNumeric: "tabular-nums" }}>
              {fmtInt(f.n)}
            </span>
          </div>
        ))}
        <div style={{ flex: 1, minWidth: 220, alignSelf: "center", fontSize: 11.5, color: "#555568", lineHeight: 1.5 }}>
          Un clic flagué reste facturé par RichAds : il est compté dans le brut et exclu des uniques,
          jamais supprimé.
        </div>
      </div>

      <div style={{ ...CARD, padding: "20px 22px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
          Clics par jour
        </div>
        {byDay.length === 0 ? (
          <div style={{ padding: "28px 0", textAlign: "center", color: "#555568", fontSize: 12.5 }}>
            Aucun clic pour l&apos;instant.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={byDay} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: "#555568", fontSize: 10.5 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: "#555568", fontSize: 10.5 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="clicks" name="Bruts" stroke="#8888A0" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="unique" name="Uniques" stroke="#10B981" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={{ ...CARD, padding: 0, overflow: "hidden" }}>
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 6, padding: "14px 18px",
          borderBottom: "1px solid rgba(255,255,255,0.07)", alignItems: "center",
        }}>
          {DIMS.map(d => (
            <button key={d.key} onClick={() => setDim(d.key)} title={d.hint} style={{
              padding: "6px 13px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: "pointer", transition: "all .15s",
              border: `1px solid ${dim === d.key ? "rgba(245,197,24,0.4)" : "rgba(255,255,255,0.08)"}`,
              background: dim === d.key ? "rgba(245,197,24,0.12)" : "transparent",
              color: dim === d.key ? "#F5C518" : "#8888A0",
            }}>{d.label}</button>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 11, color: "#555568" }}>{active.hint}</span>
        </div>
        <BreakdownTable rows={rowsByDim[dim]} dimLabel={active.label} />
      </div>

    </div>
  );
}
