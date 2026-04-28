export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import CashoutsClient from "./CashoutsClient";
import { getPlayers } from "@/lib/queries";

export default function CashoutsPage() {
  const players = getPlayers() as { id: number; name: string }[];
  return (
    <>
      <PageHeader
        title="Cashouts"
        subtitle="File d'attente des demandes de cashout — créer, approuver, marquer payé"
      />
      <CashoutsClient players={players} />
    </>
  );
}
