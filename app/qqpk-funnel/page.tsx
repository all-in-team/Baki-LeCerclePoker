export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getQqpkFunnelLeads, getQqpkFunnelWeeklyReports } from "@/lib/qqpk-funnel";
import QqpkFunnelClient from "./QqpkFunnelClient";

export default function QqpkFunnelPage() {
  const leads = getQqpkFunnelLeads();
  const reports = getQqpkFunnelWeeklyReports();

  return (
    <>
      <PageHeader
        title="QQPK Funnel"
        subtitle="Leads Instagram → bot DM · deep link ?start=qqpk · import hebdo du report room"
      />
      <QqpkFunnelClient leads={leads} reports={reports} />
    </>
  );
}
