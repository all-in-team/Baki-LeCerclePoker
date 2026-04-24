import { getCrmOverview, getCrmNotes } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import CRMClient from "./CRMClient";

export default function CRMPage() {
  const players = getCrmOverview() as any[];
  const recentNotes = getCrmNotes() as any[];
  return (
    <>
      <PageHeader title="CRM Joueurs" subtitle="Suivi des relations, activités et conversations Telegram" />
      <CRMClient players={players} recentNotes={recentNotes} />
    </>
  );
}
