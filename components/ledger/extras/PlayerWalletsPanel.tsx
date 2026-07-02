"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wallet, Plus, X, Save, ExternalLink } from "lucide-react";

/**
 * Ledger extra — per-player wallets: badge button (💼 + count, red if 0) and
 * the inline wallets panel (game wallets + cashouts).
 *
 * Extracted VERBATIM from app/a5poker/pnl/A5SettlementClient.tsx (the validated
 * A5 design): toggleWallet/saveInlineWallet logic + the wallets dropdown markup.
 * A5SettlementClient keeps its own copy until A5 migrates onto the shell.
 *
 * readOnly mode (shadow routes): addresses are displayed with Tronscan links,
 * the PUT endpoints are never called — zero write path.
 */

const TRONSCAN = "https://tronscan.org/#/address/";

export interface WalletAddr { id: number; address: string; label: string | null }

export function WalletBadgeButton({ count, isOpen, onClick }: { count: number; isOpen: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Voir / éditer les wallets du joueur"
      style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "3px 6px", borderRadius: 5, cursor: "pointer",
        background: isOpen ? "rgba(56,189,248,0.15)" : (count === 0 ? "rgba(239,68,68,0.12)" : "var(--bg-base)"),
        border: `1px solid ${isOpen ? "#38bdf8" : (count === 0 ? "#EF444440" : "var(--border)")}`,
        color: count === 0 ? "#EF4444" : "var(--text-muted)" }}>
      <Wallet size={12} />
      <span style={{ fontSize: 10, fontWeight: 700 }}>{count === 0 ? "0" : count}</span>
    </button>
  );
}

function AddrList({ label, color, addrs }: { label: string; color: string; addrs: WalletAddr[] }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 10, fontWeight: 700, color, textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>{label}</label>
      {addrs.length === 0 ? (
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Aucune adresse</span>
      ) : addrs.map(a => (
        <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontFamily: "monospace", color: "var(--text)" }}>{a.address}</span>
          {a.label && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>({a.label})</span>}
          <a href={TRONSCAN + a.address} target="_blank" rel="noreferrer" style={{ color, display: "inline-flex", alignItems: "center" }}><ExternalLink size={11} /></a>
        </div>
      ))}
    </div>
  );
}

export default function PlayerWalletsPanel({
  playerId, gameId, gameLabel, gameWallets, cashouts, readOnly = false, onClose,
}: {
  playerId: number;
  gameId: number;
  gameLabel: string;
  gameWallets: WalletAddr[];
  cashouts: WalletAddr[];
  readOnly?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [walletInlineVals, setWalletInlineVals] = useState<{ game_wallets: string[]; cashouts: string[] }>({
    game_wallets: gameWallets.length > 0 ? gameWallets.map(c => c.address) : [""],
    cashouts: cashouts.length > 0 ? cashouts.map(c => c.address) : [""],
  });
  const [savingWallet, setSavingWallet] = useState(false);

  async function saveInlineWallet() {
    setSavingWallet(true);
    try {
      const gamePayload = walletInlineVals.game_wallets.map(a => ({ address: a.trim() })).filter(a => a.address.length > 0);
      await fetch(`/api/players/${playerId}/game-wallets`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: gamePayload, game_id: gameId }) });
      const cashoutPayload = walletInlineVals.cashouts.map(a => ({ address: a.trim() })).filter(a => a.address.length > 0);
      const res = await fetch(`/api/players/${playerId}/cashouts`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ addresses: cashoutPayload, game_id: gameId }) });
      if (res.ok) { router.refresh(); } else { const err = await res.json().catch(() => null); alert(err?.error ?? "Erreur sauvegarde wallets"); }
    } finally { setSavingWallet(false); }
  }

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <Wallet size={13} color="#38bdf8" /> Wallets du joueur
        {readOnly && <span style={{ fontSize: 10, fontWeight: 700, color: "#c084fc", background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.35)", padding: "1px 8px", borderRadius: 10, textTransform: "none", letterSpacing: 0 }}>lecture seule (shadow) — édition désactivée</span>}
      </div>

      {readOnly ? (
        <>
          <AddrList label={`Wallets dépôt ${gameLabel} (game)`} color="#38bdf8" addrs={gameWallets} />
          <AddrList label="Wallets retrait / cashout" color="#fb923c" addrs={cashouts} />
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /> Fermer</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>Wallets dépôt {gameLabel} (game)</label>
            {walletInlineVals.game_wallets.map((addr, idx) => (
              <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <input value={addr} onChange={e => setWalletInlineVals(v => ({ ...v, game_wallets: v.game_wallets.map((c, i) => i === idx ? e.target.value : c) }))} placeholder="TXxxx… (adresse TRC20)" spellCheck={false} style={{ flex: 1, maxWidth: 520, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #38bdf840", outline: "none", boxSizing: "border-box" }} />
                <button onClick={() => setWalletInlineVals(v => ({ ...v, game_wallets: v.game_wallets.length === 1 ? [""] : v.game_wallets.filter((_, i) => i !== idx) }))} title="Retirer" style={{ display: "flex", alignItems: "center", padding: 6, borderRadius: 5, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /></button>
              </div>
            ))}
            <button onClick={() => setWalletInlineVals(v => ({ ...v, game_wallets: [...v.game_wallets, ""] }))} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(56,189,248,0.12)", color: "#38bdf8", border: "1px dashed #38bdf860", cursor: "pointer", marginTop: 2 }}><Plus size={11} /> Ajouter un wallet dépôt</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, fontWeight: 700, color: "#fb923c", textTransform: "uppercase", display: "block", marginBottom: 6, letterSpacing: "0.06em" }}>Wallets retrait / cashout</label>
            {walletInlineVals.cashouts.map((addr, idx) => (
              <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <input value={addr} onChange={e => setWalletInlineVals(v => ({ ...v, cashouts: v.cashouts.map((c, i) => i === idx ? e.target.value : c) }))} placeholder="TXxxx… (Binance, perso, etc.)" spellCheck={false} style={{ flex: 1, maxWidth: 520, padding: "8px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", background: "var(--bg-elevated)", color: "var(--text)", border: "1px solid #fb923c40", outline: "none", boxSizing: "border-box" }} />
                <button onClick={() => setWalletInlineVals(v => ({ ...v, cashouts: v.cashouts.length === 1 ? [""] : v.cashouts.filter((_, i) => i !== idx) }))} title="Retirer" style={{ display: "flex", alignItems: "center", padding: 6, borderRadius: 5, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /></button>
              </div>
            ))}
            <button onClick={() => setWalletInlineVals(v => ({ ...v, cashouts: [...v.cashouts, ""] }))} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 5, fontSize: 11, fontWeight: 600, background: "rgba(251,146,60,0.12)", color: "#fb923c", border: "1px dashed #fb923c60", cursor: "pointer", marginTop: 2 }}><Plus size={11} /> Ajouter une adresse cashout</button>
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={onClose} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "var(--bg-elevated)", color: "var(--text-muted)", border: "1px solid var(--border)", cursor: "pointer" }}><X size={13} /> Fermer</button>
            <button onClick={saveInlineWallet} disabled={savingWallet} style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, background: "rgba(34,197,94,0.12)", color: "var(--green)", border: "1px solid rgba(34,197,94,0.3)", cursor: "pointer", whiteSpace: "nowrap" }}><Save size={13} /> {savingWallet ? "..." : "Enregistrer les wallets"}</button>
          </div>
        </>
      )}
    </div>
  );
}
