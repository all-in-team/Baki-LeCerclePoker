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
        title="Joueurs"
        subtitle="Gère ta roster de joueurs et leurs assignations d apps."
      />
      <PlayersClient initialPlayers={players as any} apps={apps as any} />
    </div>
  );
}
