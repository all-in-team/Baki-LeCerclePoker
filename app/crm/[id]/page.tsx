import { redirect } from "next/navigation";

// L'ancienne fiche CRM et l'ancienne fiche ops ont fusionné en une seule fiche /players/[id].
// Les liens externes (Top Contributors du dashboard, favoris, historique Telegram) restent valides.
export default async function CrmPlayerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string }> }) {
  const { id } = await params;
  const { range } = await searchParams;
  redirect(`/players/${id}${range ? `?range=${range}` : ""}`);
}
