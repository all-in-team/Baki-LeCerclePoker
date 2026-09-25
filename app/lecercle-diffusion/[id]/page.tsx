export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { getBroadcast, getStats, listTargets } from "@/lib/funnels/lecercle/broadcast";
import BroadcastDetailClient from "./BroadcastDetailClient";

export default async function LecercleDiffusionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id)) notFound();
  const bc = getBroadcast(id);
  if (!bc) notFound();

  return (
    <>
      <PageHeader title={`Diffusion #${bc.id} · ${bc.title}`} subtitle="Envoyés, échecs, bloqués, clics sur le bouton, réponses sous 72 h — aucune donnée de lecture : Telegram n'en fournit pas" />
      <BroadcastDetailClient broadcast={bc} initialStats={getStats(id)} initialRows={listTargets(id)} />
    </>
  );
}
