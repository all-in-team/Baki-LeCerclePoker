export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getNexaLeads, getNexaWeeklyStats, getNexaLeadEvents } from "@/lib/nexa-funnel";
import NexaFunnelClient from "./NexaFunnelClient";

export default function NexaFunnelPage() {
  const leads = getNexaLeads();
  const stats = getNexaWeeklyStats();
  const events = getNexaLeadEvents();

  return (
    <>
      <PageHeader
        title="Nexa Funnel"
        subtitle="Leads → bot DM · deep link ?start=nexa · import hebdo du report room"
      />
      <NexaFunnelClient leads={leads} stats={stats} events={events} />
    </>
  );
}
