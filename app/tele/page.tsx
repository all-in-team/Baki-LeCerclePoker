export const dynamic = "force-dynamic";
import { getTelePlayers, getSetting } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import TELEClient from "./TELEClient";

export default function TELEPage() {
  const players = getTelePlayers();
  const walletMere = getSetting("tele_wallet_mere");
  return (
    <>
      <PageHeader
        title="TELE — Wallets"
        subtitle="Vue & vérification des adresses par joueur — WALLET GAME · WALLET CASHOUT · WALLET MÈRE"
      />
      <TELEClient players={players} walletMere={walletMere} />
    </>
  );
}
