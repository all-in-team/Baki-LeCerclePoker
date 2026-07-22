"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { FunnelLeadWithStats, FunnelWeeklyReport } from "@/lib/qqpk-funnel";

const CARD: React.CSSProperties = {
  background: "#11141A", border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 14, padding: 18,
};

const STAGE_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "🚀 Started", color: "#8888A0" },
  1: { label: "📲 App installée", color: "#60A5FA" },
  2: { label: "💰 Dépôt fait · attend ID", color: "#F0B90B" },
  3: { label: "🆔 ID reçu", color: "#34D399" },
  4: { label: "🔓 Débloqué", color: "#10B981" },
};

function fmt(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return s.slice(0, 16).replace("T", " ");
}

// Lundi de la semaine PASSÉE (Hugo uploade les chiffres de la semaine passée).
function lastWeekMonday(): string {
  const d = new Date();
  const day = d.getDay() === 0 ? 7 : d.getDay(); // lundi=1..dimanche=7
  d.setDate(d.getDate() - (day - 1) - 7);
  return d.toISOString().slice(0, 10);
}

type ImportResult = { ok?: boolean; week_start?: string; rows?: number; matched?: number; ignored?: number; error?: string };

export default function QqpkFunnelClient({ leads, reports }: {
  leads: FunnelLeadWithStats[];
  reports: FunnelWeeklyReport[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [weekStart, setWeekStart] = useState(lastWeekMonday());
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const reportsByMember = useMemo(() => {
    const m: Record<string, FunnelWeeklyReport[]> = {};
    for (const r of reports) (m[r.member_id] ??= []).push(r);
    return m;
  }, [reports]);

  const total = leads.length;
  const atLeast = (n: number) => leads.filter(l => l.stage >= n).length;
  const pct = (n: number) => total === 0 ? "—" : `${Math.round((n / total) * 100)}%`;
  const counters = [
    { label: "Started", count: total, sub: "ont lancé le bot" },
    { label: "App installée", count: atLeast(1), sub: pct(atLeast(1)) },
    { label: "Dépôt fait", count: atLeast(2), sub: pct(atLeast(2)) },
    { label: "Débloqués (ID reçu)", count: atLeast(4), sub: pct(atLeast(4)) },
    { label: "Vérifiés room", count: leads.filter(l => l.weeks_count > 0).length, sub: "ID vu dans un import" },
    { label: "Ont joué", count: leads.filter(l => l.total_rake > 0).length, sub: "rake > 0" },
  ];

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setResult({ error: "Choisis un fichier XLSX d'abord." }); return; }
    setUploading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("week_start", weekStart);
      const res = await fetch("/api/qqpk-funnel/import", { method: "POST", body: fd });
      const json = await res.json();
      setResult(json);
      if (json.ok) {
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      }
    } catch (e: any) {
      setResult({ error: e.message ?? String(e) });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Compteurs de conversion */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {counters.map(c => (
          <div key={c.label} style={CARD}>
            <div style={{ fontSize: 11, color: "#8888A0", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{c.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "#E8E8EE", marginTop: 4 }}>{c.count}</div>
            <div style={{ fontSize: 11, color: "#555568", marginTop: 2 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Import hebdo */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>
          📥 Import report hebdo (XLSX room)
        </div>
        <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>
          Chiffres de la <b>semaine passée</b> — seuls les Member ID enregistrés par un lead du funnel sont importés, le reste du back-office est ignoré. Ré-uploader la même semaine écrase (correction).
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ fontSize: 12, color: "#8888A0" }} />
          <label style={{ fontSize: 12, color: "#8888A0", display: "flex", alignItems: "center", gap: 6 }}>
            Semaine du (lundi)
            <input
              type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)}
              style={{ background: "#0B0D12", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#E8E8EE", padding: "6px 10px", fontSize: 12 }}
            />
          </label>
          <button
            onClick={handleUpload} disabled={uploading}
            style={{
              padding: "8px 16px", borderRadius: 8, border: "none", cursor: uploading ? "wait" : "pointer",
              background: "#10B981", color: "#0B0D12", fontSize: 12, fontWeight: 700,
              opacity: uploading ? 0.6 : 1,
            }}
          >
            {uploading ? "Import..." : "Importer"}
          </button>
        </div>
        {result && (
          <div style={{
            marginTop: 12, padding: "10px 14px", borderRadius: 10, fontSize: 12,
            background: result.error ? "rgba(239,68,68,0.08)" : "rgba(16,185,129,0.08)",
            border: `1px solid ${result.error ? "rgba(239,68,68,0.3)" : "rgba(16,185,129,0.3)"}`,
            color: result.error ? "#F87171" : "#34D399",
          }}>
            {result.error
              ? `❌ ${result.error}`
              : `✅ Semaine du ${result.week_start} — ${result.rows} lignes lues · ${result.matched} importées (leads funnel) · ${result.ignored} ignorées (hors funnel)`}
          </div>
        )}
      </div>

      {/* Table des leads */}
      <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
              {["Lead", "Étape", "ID joueur", "Started", "Débloqué", "Relances", "Semaines", "Σ Rake", "Σ Dépôts", "Σ Retraits", "Σ Win/Loss", ""].map(h => (
                <th key={h} style={{ textAlign: h.startsWith("Σ") || h === "Semaines" ? "right" : "left", padding: "12px 14px", fontSize: 10.5, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={12} style={{ padding: 24, textAlign: "center", color: "#555568" }}>
                Aucun lead pour l&apos;instant — partage le deep link <code style={{ color: "#8888A0" }}>t.me/LeCercle_Lebot?start=qqpk</code>
              </td></tr>
            )}
            {leads.map(lead => {
              const stage = STAGE_LABELS[lead.stage] ?? STAGE_LABELS[0];
              const weekly = lead.qqpk_member_id ? (reportsByMember[lead.qqpk_member_id] ?? []) : [];
              const isOpen = expanded[lead.id] ?? false;
              const played = lead.total_rake > 0;
              return (
                <FragmentRow
                  key={lead.id}
                  lead={lead} stage={stage} weekly={weekly} isOpen={isOpen} played={played}
                  onToggle={() => setExpanded(e => ({ ...e, [lead.id]: !isOpen }))}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentRow({ lead, stage, weekly, isOpen, played, onToggle }: {
  lead: FunnelLeadWithStats;
  stage: { label: string; color: string };
  weekly: FunnelWeeklyReport[];
  isOpen: boolean;
  played: boolean;
  onToggle: () => void;
}) {
  const name = lead.username ? `@${lead.username}` : (lead.first_name ?? `tg:${lead.telegram_id}`);
  const wl = (n: number) => (
    <span style={{ color: n > 0 ? "#34D399" : n < 0 ? "#F87171" : "#8888A0" }}>{fmt(n)}</span>
  );
  return (
    <>
      <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", opacity: lead.blocked ? 0.5 : 1 }}>
        <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
          <span style={{ color: "#E8E8EE", fontWeight: 600 }}>{name}</span>
          {lead.first_name && lead.username && <span style={{ color: "#555568", marginLeft: 6 }}>{lead.first_name}</span>}
          {lead.blocked === 1 && <span style={{ marginLeft: 6, fontSize: 10, color: "#F87171" }}>🚫 bot bloqué</span>}
          {played && <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,0.12)", color: "#10B981", fontWeight: 700 }}>A JOUÉ</span>}
        </td>
        <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
          <span style={{ color: stage.color, fontWeight: 600 }}>{stage.label}</span>
        </td>
        <td style={{ padding: "10px 14px", color: "#E8E8EE", fontFamily: "monospace", whiteSpace: "nowrap" }}>
          {lead.qqpk_member_id ?? "—"}
          {lead.nickname && <span style={{ color: "#555568", marginLeft: 6, fontFamily: "inherit" }}>({lead.nickname})</span>}
          {/* Vérifié = l'ID apparaît dans au moins un export hebdo de la room → le compte
              existe vraiment. Un ID inventé reste "à vérifier" pour toujours. */}
          {lead.qqpk_member_id && (lead.weeks_count > 0 ? (
            <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,0.12)", color: "#10B981", fontWeight: 700, fontFamily: "inherit" }}>✓ VÉRIFIÉ</span>
          ) : (
            <span style={{ marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(240,185,11,0.10)", color: "#F0B90B", fontWeight: 600, fontFamily: "inherit" }} title="ID jamais vu dans un import — vérifié au prochain import hebdo, ou ID bidon">⏳ à vérifier</span>
          ))}
        </td>
        <td style={{ padding: "10px 14px", color: "#8888A0", whiteSpace: "nowrap" }}>{fmtDate(lead.created_at)}</td>
        <td style={{ padding: "10px 14px", color: "#8888A0", whiteSpace: "nowrap" }}>{fmtDate(lead.stage4_at)}</td>
        <td style={{ padding: "10px 14px", color: lead.reminders_sent > 0 ? "#F0B90B" : "#555568" }}>{lead.reminders_sent}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#8888A0" }}>{lead.weeks_count || "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#E8E8EE", fontWeight: 600 }}>{lead.weeks_count ? fmt(lead.total_rake) : "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#8888A0" }}>{lead.weeks_count ? fmt(lead.total_deposits) : "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right", color: "#8888A0" }}>{lead.weeks_count ? fmt(lead.total_withdrawals) : "—"}</td>
        <td style={{ padding: "10px 14px", textAlign: "right" }}>{lead.weeks_count ? wl(lead.total_winloss) : <span style={{ color: "#555568" }}>—</span>}</td>
        <td style={{ padding: "10px 14px" }}>
          {weekly.length > 0 && (
            <button onClick={onToggle} style={{
              background: "none", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
              color: "#8888A0", fontSize: 10.5, padding: "3px 8px", cursor: "pointer", whiteSpace: "nowrap",
            }}>
              {isOpen ? "▲ Replier" : `▼ ${weekly.length} sem.`}
            </button>
          )}
        </td>
      </tr>
      {isOpen && weekly.length > 0 && (
        <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <td colSpan={12} style={{ padding: "0 14px 12px", background: "rgba(255,255,255,0.015)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
              <thead>
                <tr>
                  {["Semaine du", "Rake", "Dépôts", "Retraits", "Win/Loss", "Insurance", "Rewards"].map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "6px 10px", fontSize: 10, fontWeight: 700, color: "#555568", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...weekly].reverse().map(w => (
                  <tr key={w.week_start} style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={{ padding: "6px 10px", color: "#8888A0" }}>{w.week_start}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: "#E8E8EE" }}>{fmt(w.rake)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: "#8888A0" }}>{fmt(w.deposits)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: "#8888A0" }}>{fmt(w.withdrawals)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right" }}>{wl(w.winloss)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: "#8888A0" }}>{fmt(w.insurance)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: "#8888A0" }}>{fmt(w.rewards)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
