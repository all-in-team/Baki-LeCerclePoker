"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet, RefreshCw, ExternalLink, AlertTriangle } from "lucide-react";

// Trésorerie live — remplace l'OPS FEED (demande Hugo 2026-07-17) : total USDT en
// haut, puis le solde de chaque wallet opérationnel. Affichage pur : les soldes
// viennent de /api/treasury (TronGrid, cache serveur 60 s), zéro math ici.

const TRONSCAN_ADDR = "https://tronscan.org/#/address/";
const REFRESH_MS = 60_000;

interface TreasuryWallet {
  label: string;
  address: string;
  usdt: number | null;
  error?: string;
}
interface Snapshot {
  ok: boolean;
  updated_at: string;
  total_usdt: number;
  complete: boolean;
  wallets: TreasuryWallet[];
}

function fmtUsdt(n: number): string {
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function TreasuryPanel() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/treasury");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnap(await res.json());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const updatedTime = snap
    ? new Date(snap.updated_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Paris" })
    : null;

  return (
    <div className="glass-card" style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <Wallet size={14} color="#F5C518" />
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", color: "#E8E8EE" }}>TRÉSORERIE — LIVE</span>
        <div style={{ flex: 1 }} />
        {updatedTime && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>au {updatedTime}</span>}
        <button
          onClick={load}
          disabled={loading}
          title="Rafraîchir les soldes (auto toutes les 60 s)"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 2, display: "inline-flex" }}
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
        </button>
      </div>

      <div style={{ padding: "18px 16px 10px", borderBottom: "1px solid var(--border)", textAlign: "center" }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", color: "var(--text-muted)", marginBottom: 6 }}>
          USDT DISPONIBLE — TOUS WALLETS
        </div>
        {snap ? (
          <div style={{ fontSize: 30, fontWeight: 800, color: "#F5C518", fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
            {fmtUsdt(snap.total_usdt)} <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>USDT</span>
          </div>
        ) : (
          <div style={{ fontSize: 30, fontWeight: 800, color: "var(--text-dim)" }}>{error ? "—" : "…"}</div>
        )}
        {snap && !snap.complete && (
          <div style={{ marginTop: 6, fontSize: 10, color: "#F5C518", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <AlertTriangle size={11} /> total partiel — un wallet n&apos;a pas répondu
          </div>
        )}
        {error && (
          <div style={{ marginTop: 6, fontSize: 10, color: "#EF4444" }}>Erreur de chargement ({error}) — retry auto dans 60 s</div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
        {(snap?.wallets ?? []).map((w) => (
          <div key={w.address} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#E8E8EE", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.label}</div>
              <a
                href={TRONSCAN_ADDR + w.address}
                target="_blank"
                rel="noopener noreferrer"
                title={w.address}
                style={{ fontSize: 10, color: "var(--text-dim)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}
              >
                {w.address.slice(0, 6)}…{w.address.slice(-6)} <ExternalLink size={9} />
              </a>
            </div>
            {w.usdt === null ? (
              <span title={w.error} style={{ fontSize: 11, color: "#EF4444", cursor: "help" }}>erreur</span>
            ) : (
              <span style={{ fontSize: 14, fontWeight: 700, color: "#10B981", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {fmtUsdt(w.usdt)} <span style={{ fontSize: 10, fontWeight: 500, color: "var(--text-muted)" }}>USDT</span>
              </span>
            )}
          </div>
        ))}
        {!snap && !error && (
          <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>Chargement des soldes on-chain…</div>
        )}
      </div>
    </div>
  );
}
