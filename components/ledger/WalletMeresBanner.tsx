import { ExternalLink } from "lucide-react";
import type { WalletMere } from "@/lib/queries";

/**
 * Wallet-mère banner — shared display block for LedgerShell's
 * `walletMeresBanner` slot. Extracted from the shadow pilots
 * (kkpoker/nutspk shadow pages keep their local copies until cleanup).
 */

const TRONSCAN = "https://tronscan.org/#/address/";

export default function WalletMeresBanner({ walletMeres }: { walletMeres: WalletMere[] }) {
  if (walletMeres.length === 0) return null;
  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        WALLET{walletMeres.length > 1 ? "S" : ""} MÈRE{walletMeres.length > 1 ? "S" : ""}
      </div>
      {walletMeres.map(wm => (
        <a key={wm.id} href={TRONSCAN + wm.address} target="_blank" rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", padding: "4px 10px", background: "rgba(74,222,128,0.08)", borderRadius: 6, border: "1px solid rgba(74,222,128,0.2)" }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", color: "#4ade80", fontWeight: 600 }}>
            {wm.label ? `${wm.label}: ` : ""}{wm.address.slice(0, 6)}…{wm.address.slice(-6)}
          </span>
          <ExternalLink size={10} color="#4ade80" />
        </a>
      ))}
    </div>
  );
}
