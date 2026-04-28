"use client";

import { useState } from "react";
import Btn from "@/components/Btn";
import { CheckCircle, AlertCircle, Shield, Wifi, DollarSign } from "lucide-react";

const TELE_FIELDS = [
  {
    key: "tele_wallet_mere",
    label: "WALLET MÈRE",
    desc: "Wallet de trésorerie de l'app — envoie tous les cashouts vers les WALLET CASHOUT des joueurs",
    placeholder: "TXxxx... (adresse TRX)",
  },
];

const EXCHANGE_RATE_FIELDS = [
  {
    key: "exchange_rate_cny_usdt",
    label: "CNY → USDT",
    desc: "Taux de conversion Yuan chinois vers USDT (Wepoker est en CNY)",
    placeholder: "0.138",
  },
  {
    key: "exchange_rate_eur_usdt",
    label: "EUR → USDT",
    desc: "Taux de conversion Euro vers USDT",
    placeholder: "1.08",
  },
];

function isTronAddr(v: string) {
  return /^T[a-zA-Z0-9]{33}$/.test(v.trim());
}

export default function SettingsClient({
  initialSettings,
}: {
  initialSettings: Record<string, string>;
}) {
  const [values, setValues] = useState<Record<string, string>>(initialSettings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError]  = useState<string | null>(null);

  function set(key: string, val: string) {
    setValues(v => ({ ...v, [key]: val }));
    setSaved(false);
    setError(null);
  }

  async function save() {
    // Validate Tron addresses
    for (const { key, label } of TELE_FIELDS) {
      const v = (values[key] ?? "").trim();
      if (v && !isTronAddr(v)) {
        setError(`${label} : adresse invalide (doit commencer par T, 34 caractères)`);
        return;
      }
    }
    // Validate exchange rates
    for (const { key, label } of EXCHANGE_RATE_FIELDS) {
      const v = (values[key] ?? "").trim();
      if (v && (isNaN(parseFloat(v)) || parseFloat(v) <= 0)) {
        setError(`${label} : taux invalide (nombre positif requis)`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, string | null> = {};
      for (const f of TELE_FIELDS) payload[f.key] = (values[f.key] ?? "").trim() || null;
      for (const f of EXCHANGE_RATE_FIELDS) payload[f.key] = (values[f.key] ?? "").trim() || null;

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Erreur serveur");
      setSaved(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  const configured = TELE_FIELDS.every(f => isTronAddr(values[f.key] ?? ""));

  return (
    <div style={{ maxWidth: 680 }}>

      {/* Exchange rates section */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
          <DollarSign size={16} color="#fbbf24" />
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Taux de change</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>— Normalisation multi-devises vers USDT</span>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.18)", borderRadius: 8, padding: "12px 14px", marginBottom: 20, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
            <DollarSign size={12} style={{ display: "inline", marginRight: 6, color: "#fbbf24" }} />
            Les rapports Wepoker sont en <strong style={{ color: "var(--text)" }}>CNY</strong>. Ces taux convertissent automatiquement tous les montants en USDT pour le P&L unifié.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {EXCHANGE_RATE_FIELDS.map(({ key, label, desc, placeholder }) => {
              const val = values[key] ?? "";
              const valid = !val || (!isNaN(parseFloat(val)) && parseFloat(val) > 0);
              return (
                <div key={key}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>
                    {label}
                  </label>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{desc}</div>
                  <input
                    value={val}
                    onChange={e => set(key, e.target.value)}
                    placeholder={placeholder}
                    type="text"
                    inputMode="decimal"
                    style={{
                      width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 13,
                      background: "var(--bg-surface)", color: "var(--text)",
                      border: `1px solid ${!valid ? "#f87171" : val ? "var(--green)" : "var(--border)"}`,
                      outline: "none", boxSizing: "border-box",
                    }}
                  />
                  {val && !valid && (
                    <div style={{ fontSize: 11, color: "#f87171", marginTop: 4 }}>Nombre positif requis</div>
                  )}
                  {val && valid && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                      1 {label.split(" → ")[0]} = {parseFloat(val)} USDT
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* TELE section */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 24 }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
          <Wifi size={16} color="#a78bfa" />
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>TELE — Architecture 3 wallets</span>
          {configured ? (
            <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 20, background: "rgba(34,197,94,0.12)", color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}>
              <CheckCircle size={11} /> Configuré — mode précis actif
            </span>
          ) : (
            <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 20, background: "rgba(248,113,113,0.12)", color: "#f87171", display: "flex", alignItems: "center", gap: 4 }}>
              <AlertCircle size={11} /> Mode direction (fallback)
            </span>
          )}
        </div>

        <div style={{ padding: 20 }}>
          {/* Mode explanation */}
          <div style={{ background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.18)", borderRadius: 8, padding: "12px 14px", marginBottom: 20, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
            <Shield size={12} style={{ display: "inline", marginRight: 6, color: "#a78bfa" }} />
            <strong style={{ color: "var(--text)" }}>Mode précis (recommandé) :</strong> le sync ne compte que les dépôts vers l'ACCOUNT WALLET et les retraits depuis le WALLET MÈRE.
            Les autres transferts USDT du joueur sont ignorés.
            <br />
            <span style={{ color: "var(--text-dim)" }}>Sans ces adresses : le sync utilise la direction du flux (moins précis, peut capter des faux positifs).</span>
          </div>

          {TELE_FIELDS.map(({ key, label, desc, placeholder }) => {
            const val = values[key] ?? "";
            const valid = !val || isTronAddr(val);
            return (
              <div key={key} style={{ marginBottom: 18 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", display: "block", marginBottom: 6 }}>
                  {label}
                </label>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{desc}</div>
                <input
                  value={val}
                  onChange={e => set(key, e.target.value)}
                  placeholder={placeholder}
                  spellCheck={false}
                  style={{
                    width: "100%", padding: "9px 12px", borderRadius: 7, fontSize: 12, fontFamily: "monospace",
                    background: "var(--bg-surface)", color: "var(--text)",
                    border: `1px solid ${!valid ? "#f87171" : val ? "var(--green)" : "var(--border)"}`,
                    outline: "none", boxSizing: "border-box",
                  }}
                />
                {val && !valid && (
                  <div style={{ fontSize: 11, color: "#f87171", marginTop: 4 }}>Adresse invalide (T + 33 caractères)</div>
                )}
                {val && valid && (
                  <div style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>
                    <CheckCircle size={10} style={{ display: "inline", marginRight: 4 }} />
                    {val.slice(0, 6)}…{val.slice(-6)}
                  </div>
                )}
              </div>
            );
          })}

        </div>
      </div>

      {/* Save button + error (covers all sections) */}
      <div style={{ marginBottom: 24 }}>
        {error && (
          <div style={{ padding: "10px 14px", background: "rgba(248,113,113,0.10)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 7, fontSize: 12, color: "#f87171", marginBottom: 14 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Btn onClick={save} disabled={saving}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </Btn>
          {saved && (
            <span style={{ fontSize: 12, color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}>
              <CheckCircle size={13} /> Sauvegardé
            </span>
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.07em" }}>Architecture TELE</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {[
            { label: "WALLET GAME", desc: "Adresse dédiée du joueur dans l'app — reçoit ses dépôts. Entré sur la fiche joueur.", color: "#38bdf8" },
            { label: "WALLET CASHOUT", desc: "Adresse fixe du joueur (Binance TRC20 ou perso) — à renseigner dans la vue TELE.", color: "#fb923c" },
            { label: "WALLET MÈRE", desc: "Tréso de l'app — envoie tous les cashouts vers les WALLET CASHOUT. À configurer ici.", color: "#4ade80" },
          ].map(({ label, desc, color }) => (
            <div key={label} style={{ padding: "10px 12px", background: "var(--bg-surface)", borderRadius: 7, borderLeft: `3px solid ${color}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{desc}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
          <strong style={{ color: "var(--text-muted)" }}>Dépôt :</strong> Wallet du joueur → WALLET GAME (chips crédités)<br />
          <strong style={{ color: "var(--text-muted)" }}>Cashout :</strong> WALLET MÈRE → WALLET CASHOUT (l'app paie le joueur)<br />
          <strong style={{ color: "#fb923c" }}>WALLET CASHOUT</strong> : adresse fixe à renseigner manuellement dans la vue <strong>TELE</strong> par joueur.
        </div>
      </div>
    </div>
  );
}
