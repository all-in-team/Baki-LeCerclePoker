"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import Btn from "@/components/Btn";

/**
 * Ledger extra — "Sync Wallets" action for LedgerShell's `actions` slot.
 * Same call as TELEClient/A5SettlementClient: POST /api/wallets/sync with the
 * game's DB name. The sync logic itself (cashout source rule included) lives
 * untouched in app/api/wallets/sync/route.ts.
 */
export default function SyncWalletsButton({ gameName, label }: { gameName: string; label?: string }) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ imported: number; results?: { player: string; imported: number; error?: string }[] } | null>(null);

  async function syncWallets() {
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch("/api/wallets/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ game_name: gameName }) });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "Erreur sync"); return; }
      setSyncResult(data);
      if (data.imported > 0) setTimeout(() => window.location.reload(), 1200);
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
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
