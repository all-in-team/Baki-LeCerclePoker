export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getDzpkDashboard } from "@/lib/funnels/dzpk/dashboard";
import { getDzpkWeeklyReport, getWelcomeAbStats } from "@/lib/funnels/dzpk/report";
import { listBroadcasts, getGuard } from "@/lib/funnels/dzpk/broadcast";
import DzpkFunnelClient from "./DzpkFunnelClient";

export default function DzpkFunnelPage() {
  const data = getDzpkDashboard();

  return (
    <>
      <PageHeader
        title="DZPK Funnel"
        subtitle="Leads → bot dzpk · deep link ?start=<source> · notifs du club appariées par nom d'affichage"
      />
      <DzpkFunnelClient
        leads={data.leads}
        commissions={data.commissions}
        pending={data.pending}
        orphans={data.orphans}
        // Lu ici plutôt que par un fetch au montage : l'écran de diffusion doit
        // afficher le garde-fou anti-spam AVANT le premier rendu. Un compteur
        // qui apparaît une seconde après la page est un compteur qu'on clique
        // par-dessus sans l'avoir lu.
        broadcasts={listBroadcasts(20)}
        guard={getGuard()}
        weekly={getDzpkWeeklyReport()}
        abStats={getWelcomeAbStats()}
      />
    </>
  );
}
