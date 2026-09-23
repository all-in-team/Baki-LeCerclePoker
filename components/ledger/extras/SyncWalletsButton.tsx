"use client";

import { useState } from "react";
import { RefreshCw, AlertTriangle } from "lucide-react";
import Btn from "@/components/Btn";

/**
 * Ledger extra — "Sync Wallets" action for LedgerShell's `actions` slot.
 * Same call as TELEClient/A5SettlementClient: POST /api/wallets/sync with the
 * game's DB name. The sync logic itself (cashout source rule included) lives
 * untouched in app/api/wallets/sync/route.ts — ce composant ne fait qu'AFFICHER
 * ce qu'elle rend, y compris les lignes qu'elle a écartées.
 */
type SkippedLine = { player: string; game_wallet: string; from: string; amount: number; tx_datetime: string; tron_tx_hash: string };
type SyncResult = {
  imported: number;
  skipped_from_mere?: number;
  skipped_details?: SkippedLine[];
  results?: { player: string; imported: number; error?: string }[];
};

export default function SyncWalletsButton({ gameName, label }: { gameName: string; label?: string }) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);

  async function syncWallets() {
    setSyncing(true); setSyncResult(null); setShowSkipped(false);
    try {
      const res = await fetch("/api/wallets/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ game_name: gameName }) });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "Erreur sync"); return; }
      setSyncResult(data);
      // Rechargement auto SEULEMENT si rien n'a été écarté : sinon il effacerait
      // l'avertissement avant que Baki ait pu le lire (c'est exactement comme ça
      // que 5 dépôts de Raph sont passés inaperçus le 2026-09-22).
      if (data.imported > 0 && !data.skipped_from_mere) setTimeout(() => window.location.reload(), 1200);
    } finally { setSyncing(false); }
  }

  return (
    <>
      <Btn variant="secondary" onClick={syncWallets} disabled={syncing}>
        <RefreshCw size={14} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
        {syncing ? "Sync en cours…" : label ?? "Sync Wallets"}
      </Btn>
      {syncResult && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 6, background: syncResult.imported > 0 ? "rgba(34,197,94,0.12)" : "rgba(136,136,160,0.10)", color: syncResult.imported > 0 ? "var(--green)" : "var(--text-muted)" }}>
            {syncResult.imported > 0 ? `+${syncResult.imported} importés` : "Déjà à jour"}
          </span>
          {syncResult.results?.filter(r => r.error).map(r => (
            <span key={r.player} style={{ fontSize: 11, color: "#f87171" }}>{r.player}: {r.error}</span>
          ))}
          {/* Lignes écartées par la garde mère. Un compteur muet ne suffit pas :
              c'est le détail qui permet de dire en un coup d'œil si un vrai dépôt
              vient d'être perdu. Visible tant qu'on n'a pas rechargé la page. */}
          {!!syncResult.skipped_from_mere && (
            <div style={{ border: "1px solid rgba(251,191,36,0.35)", background: "rgba(251,191,36,0.08)", borderRadius: 6, padding: "6px 10px", maxWidth: 560 }}>
              <button
                onClick={() => setShowSkipped(s => !s)}
                style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#fbbf24" }}
              >
                <AlertTriangle size={13} />
                {syncResult.skipped_from_mere} ligne{syncResult.skipped_from_mere > 1 ? "s" : ""} écartée{syncResult.skipped_from_mere > 1 ? "s" : ""} (expéditeur = wallet mère)
                <span style={{ fontWeight: 400, opacity: 0.8 }}>{showSkipped ? "▾ masquer" : "▸ détail"}</span>
              </button>
              {showSkipped && (
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                  {syncResult.skipped_details?.map(s => (
                    <div key={s.tron_tx_hash} style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "ui-monospace, monospace" }}>
                      <span style={{ color: "#fbbf24" }}>{s.amount} USDT</span>
                      {" · "}{s.player}{" · "}{s.tx_datetime?.slice(0, 16).replace("T", " ")}
                      {" · de "}<a href={`https://tronscan.org/#/address/${s.from}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{s.from.slice(0, 10)}…</a>
                      {" · "}<a href={`https://tronscan.org/#/transaction/${s.tron_tx_hash}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>tx</a>
                    </div>
                  ))}
                  <span style={{ fontSize: 10, color: "var(--text-muted)", opacity: 0.8, fontStyle: "italic" }}>
                    Écarté = pas importé du tout. Si l'expéditeur est le hot wallet d'une room et non ta wallet de paiement, c'est un vrai dépôt : il faut le reclasser (wallet_meres.kind).
                  </span>
                </div>
              )}
            </div>
          )}
          {syncResult.skipped_from_mere === 0 && syncResult.imported > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>0 ligne écartée</span>
          )}
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
