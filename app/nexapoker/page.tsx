export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getSetting } from "@/lib/queries";
import { currentWeekMonday } from "@/lib/funnels/nexa/players";
import NexaPokerClient from "./NexaPokerClient";
import SaisieClient from "./SaisieClient";

/**
 * NEXAPOKER — page de room, UNE seule page.
 *
 * Joueurs, parts d'action et réconciliation en haut ; saisie hebdomadaire
 * (extraction de screenshot + grille) en bas. Le geste du lundi et l'état des
 * joueurs sont sous les yeux au même endroit — c'était le point du regroupement.
 * /nexa/saisie redirige ici (l'URL était en favori).
 *
 * Écart assumé avec les autres pages de rooms (/kkpoker/pnl, /a5nuts/pnl,
 * /aks/pnl) : elles passent par LedgerShell + loadWalletLedger, câblés sur la
 * synchro wallet on-chain et les settlements, que NEXAPOKER n'a pas — ses
 * mouvements passent par Hugo en système d'agent. La bascule deviendra naturelle
 * au rattachement du hub /payments (étape 7).
 *
 * Les dates sont calculées CÔTÉ SERVEUR : ni la semaine d'effet d'une part
 * d'action, ni la date d'un mouvement ne doivent dépendre du fuseau du navigateur.
 */
export default function NexaPokerPage() {
  const today = new Date().toISOString().slice(0, 10);
  // Le deal par défaut est un RÉGLAGE, jamais un taux en dur : les taux effectifs
  // sont toujours ceux parsés depuis le deal_text de chaque ligne.
  const defaultDeal = getSetting("nexa_default_deal_text") ?? "";

  return (
    <>
      <PageHeader
        title="NEXAPOKER"
        subtitle="Joueurs, parts d'action, mouvements et saisie hebdomadaire du report"
      />
      <NexaPokerClient currentWeek={currentWeekMonday()} today={today} />

      <div id="saisie" style={{ marginTop: 28, scrollMarginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#E8E8EE", marginBottom: 4 }}>
          📷 Saisie de la semaine
        </div>
        <div style={{ fontSize: 12, color: "#8888A0", marginBottom: 14 }}>
          Dépose le screenshot du report NEXA : la grille se pré-remplit, tu relis, tu enregistres.
          Rien n'est écrit tant que tu n'as pas cliqué sur Enregistrer.
        </div>
        <SaisieClient defaultDeal={defaultDeal} initialWeek={lastMonday()} />
      </div>
    </>
  );
}

/** Lundi de la semaine passée — la semaine qu'on recopie en général. */
function lastMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}
