export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { listBroadcasts, getGuard, allowedTestChatIds } from "@/lib/funnels/lecercle/broadcast";
import { getAudienceFacets } from "@/lib/funnels/lecercle/audience";
import LecercleBroadcastClient from "./LecercleBroadcastClient";

export default function LecercleDiffusionPage() {
  return (
    <>
      <PageHeader
        title="Diffusion bot"
        subtitle="Push vers ceux qui ont parlé à @LeCercle_Lebot · envoyés, échecs, bloqués, clics sur le bouton, réponses sous 72 h — Telegram ne donne aucun accusé de lecture"
      />
      <LecercleBroadcastClient
        facets={getAudienceFacets()}
        initialBroadcasts={listBroadcasts(30)}
        initialGuard={getGuard()}
        testChatId={allowedTestChatIds()[0] ?? null}
      />
    </>
  );
}
