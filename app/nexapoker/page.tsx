export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { currentWeekMonday } from "@/lib/funnels/nexa/players";
import NexaPokerClient from "./NexaPokerClient";

/**
 * NEXAPOKER — page de room.
 *
 * Écart assumé avec les autres pages de games (/kkpoker/pnl, /a5nuts/pnl,
 * /aks/pnl) : celles-ci passent par LedgerShell + loadWalletLedger, câblés sur la
 * synchro wallet on-chain et les settlements. NEXAPOKER n'a ni l'un ni l'autre —
 * ses mouvements passent par Hugo en système d'agent. On utilise donc PageHeader,
 * l'autre pattern du repo. La bascule vers LedgerShell deviendra naturelle avec
 * les buy-in/cash-out (point 6) et le rattachement au hub /payments (étape 7).
 *
 * La semaine en cours est calculée CÔTÉ SERVEUR et passée en prop : le défaut de
 * la semaine d'effet ne doit pas dépendre du fuseau du navigateur.
 */
export default function NexaPokerPage() {
  return (
    <>
      <PageHeader
        title="NEXAPOKER"
        subtitle="Joueurs, parts d'action et réconciliation du report d'affiliation"
      />
      <NexaPokerClient currentWeek={currentWeekMonday()} />
    </>
  );
}
