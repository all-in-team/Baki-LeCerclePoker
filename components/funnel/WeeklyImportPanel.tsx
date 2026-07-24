"use client";

import { useRef, useState } from "react";
import { lastWeekMonday } from "@/lib/funnels/shared";
import { FUNNEL_CARD } from "./styles";

export type ImportResult = {
  ok?: boolean;
  week_start?: string;
  rows?: number;
  matched?: number;
  ignored?: number;
  /** Rooms qui promeuvent les leads à "vérifié" à l'import (optionnel). */
  newly_verified?: number;
  error?: string;
};

/**
 * Bloc d'import du report hebdo d'une room : fichier + semaine (lundi) + résumé.
 * Générique multi-rooms — seuls l'endpoint et le texte d'aide changent.
 */
export default function WeeklyImportPanel({
  endpoint, description, onImported,
}: {
  endpoint: string;
  description: React.ReactNode;
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [weekStart, setWeekStart] = useState(lastWeekMonday());
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setResult({ error: "Choisis un fichier XLSX d'abord." }); return; }
    setUploading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("week_start", weekStart);
      const res = await fetch(endpoint, { method: "POST", body: fd });
      const json = await res.json();
      setResult(json);
      if (json.ok) {
        if (fileRef.current) fileRef.current.value = "";
        onImported();
      }
    } catch (e: any) {
      setResult({ error: e.message ?? String(e) });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={FUNNEL_CARD}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8EE", marginBottom: 4 }}>
        📥 Import report hebdo (XLSX room)
      </div>
      <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 12 }}>{description}</div>
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
            : `✅ Semaine du ${result.week_start} — ${result.rows} lignes lues · ${result.matched} importées (leads funnel) · ${result.ignored} ignorées (hors funnel)`
              + (result.newly_verified != null ? ` · ${result.newly_verified} nouveaux vérifiés` : "")}
        </div>
      )}
    </div>
  );
}
