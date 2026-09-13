export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import AkMultiClient from "./AkMultiClient";
import { listPoolPlayers } from "@/lib/pool/periods";
import { poolNow } from "@/lib/pool/clock";

/**
 * AK multi-Account — règlement sur le POOL des soldes du joueur.
 *
 * Une page, un joueur à la fois : ses comptes (AK + OkPay), sa main (lue sur le
 * grand livre OkPay transféré, ou saisie), ses mouvements externes, la clôture à
 * l'instant choisi, et l'historique des périodes figées. Modèle et invariants :
 * docs/POOL_MULTI_ACCOUNT.md. Les chiffres viennent TOUS de lib/pool/periods
 * (preview = lock) ; l'écran ne calcule rien.
 *
 * `now` est calculé côté serveur en heure murale (lib/pool/clock) : ni le fuseau
 * du navigateur ni celui de Railway ne doivent décider si une clôture est
 * « dans le futur ».
 */
export default async function AkMultiPage() {
  const enrolled = listPoolPlayers();
  const now = poolNow();
  return (
    <div>
      <PageHeader
        title="AK multi-Account"
        subtitle="Règlement sur le pool : main OkPay + Σ AK + Σ OkPay. Le grand livre OkPay arrive par message transféré au bot ; le textarea en bas est le filet de secours."
      />
      <AkMultiClient initialPlayers={enrolled} serverNow={now} />
    </div>
  );
}
