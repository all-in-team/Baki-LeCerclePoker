"use client";

import { useState } from "react";
import { Send, AlertTriangle, CheckCircle, Loader } from "lucide-react";
import Btn from "@/components/Btn";

export default function DashboardActions() {
  const [weeklyStatus, setWeeklyStatus] = useState<string | null>(null);
  const [alertStatus, setAlertStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  async function sendWeekly() {
    setLoading("weekly");
    setWeeklyStatus(null);
    try {
      const res = await fetch("/api/weekly-summary", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setWeeklyStatus(`Envoyé à ${data.sent} joueur(s), ${data.skipped} sans solde`);
      } else {
        setWeeklyStatus(`Erreur: ${data.error ?? "inconnue"}`);
      }
    } catch {
      setWeeklyStatus("Erreur réseau");
    }
    setLoading(null);
  }

  async function checkAlerts() {
    setLoading("alerts");
    setAlertStatus(null);
    try {
      const res = await fetch("/api/alerts?notify=true");
      const data = await res.json();
      if (data.count === 0) {
        setAlertStatus("Aucun joueur sous le seuil");
      } else {
        setAlertStatus(`${data.count} alerte(s) envoyée(s) sur Telegram`);
      }
    } catch {
      setAlertStatus("Erreur réseau");
    }
    setLoading(null);
  }

  return (
    <div style={{
      display: "flex", gap: 12, marginBottom: 24, padding: "14px 18px",
      background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10,
      alignItems: "center", flexWrap: "wrap",
    }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 8 }}>
        Actions rapides
      </span>

      <Btn size="sm" onClick={sendWeekly} disabled={loading === "weekly"}>
        {loading === "weekly" ? <Loader size={12} className="spin" /> : <Send size={12} />}
        Envoyer récap hebdo
      </Btn>
      {weeklyStatus && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
          <CheckCircle size={11} color="var(--green)" /> {weeklyStatus}
        </span>
      )}

      <Btn size="sm" onClick={checkAlerts} disabled={loading === "alerts"}>
        {loading === "alerts" ? <Loader size={12} className="spin" /> : <AlertTriangle size={12} />}
        Vérifier alertes P&L
      </Btn>
      {alertStatus && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
          <CheckCircle size={11} color="var(--green)" /> {alertStatus}
        </span>
      )}
    </div>
  );
}
