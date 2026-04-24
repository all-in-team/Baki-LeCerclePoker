export const dynamic = "force-dynamic";
import { getLedger, getPlayers } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import LedgerClient from "./LedgerClient";

export default function LedgerPage() {
  const txs = getLedger();
  const players = getPlayers();
  return (
    <div>
      <PageHeader title="Telegram Ledger" subtitle="Track all cash movements with players" />
      <LedgerClient
        initialTxs={txs as Parameters<typeof LedgerClient>[0]["initialTxs"]}
        players={players as Parameters<typeof LedgerClient>[0]["players"]}
      />
    </div>
  );
}
