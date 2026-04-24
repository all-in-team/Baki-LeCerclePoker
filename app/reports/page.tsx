export const dynamic = "force-dynamic";
import { getReports, getApps, getPlayers } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import ReportsClient from "./ReportsClient";

export default function ReportsPage() {
  const reports = getReports();
  const apps = getApps();
  const players = getPlayers();
  return (
    <div>
      <PageHeader title="Report Importer" subtitle="Upload or paste reports from apps, create accounting entries" />
      <ReportsClient
        initialReports={reports as Parameters<typeof ReportsClient>[0]["initialReports"]}
        apps={apps as Parameters<typeof ReportsClient>[0]["apps"]}
        players={players as Parameters<typeof ReportsClient>[0]["players"]}
      />
    </div>
  );
}
