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
      display: "flex", gap: 12, marginBottom: 24, padding: "14px 20px",
      background: "#1A1D23", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14,
      alignItems: "center", flexWrap: "wrap",
    }}>
      <span style={{
        fontSize: 11, fontWeight: 600, color: "#555568",
        textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 8,
      }}>
        Actions rapides
      </span>

      <Btn size="sm" onClick={sendWeekly} disabled={loading === "weekly"}>
        {loading === "weekly" ? <Loader size={12} className="animate-spin" /> : <Send size={12} />}
        Envoyer récap hebdo
      </Btn>
      {weeklyStatus && (
        <span style={{ fontSize: 11, color: "#8888A0", display: "flex", alignItems: "center", gap: 4 }}>
          <CheckCircle size={11} color="#10B981" /> {weeklyStatus}
        </span>
      )}

      <Btn size="sm" onClick={checkAlerts} disabled={loading === "alerts"}>
        {loading === "alerts" ? <Loader size={12} className="animate-spin" /> : <AlertTriangle size={12} />}
        Vérifier alertes P&L
      </Btn>
      {alertStatus && (
        <span style={{ fontSize: 11, color: "#8888A0", display: "flex", alignItems: "center", gap: 4 }}>
          <CheckCircle size={11} color="#10B981" /> {alertStatus}
        </span>
      )}
    </div>
  );
}
