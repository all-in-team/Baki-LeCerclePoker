export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getDzpkDashboard } from "@/lib/funnels/dzpk/dashboard";
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
      />
    </>
  );
}
