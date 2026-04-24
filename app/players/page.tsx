export const dynamic = "force-dynamic";
import { getPlayers, getApps } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import PlayersClient from "./PlayersClient";

export default function PlayersPage() {
  const players = getPlayers();
  const apps = getApps();
  return (
    <div>
      <PageHeader
        title="Players"
        subtitle="Manage your player roster and their app assignments"
      />
      <PlayersClient initialPlayers={players as any} apps={apps as any} />
    </div>
  );
}
