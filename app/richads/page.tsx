export const dynamic = "force-dynamic";

import PageHeader from "@/components/PageHeader";
import { getRichAdsStats, getDestUrl } from "@/lib/richads";
import RichAdsClient from "./RichAdsClient";

export default function RichAdsPage() {
  const stats = getRichAdsStats();

  return (
    <>
      <PageHeader
        title="RichAds — test dzpk"
        subtitle="Clics d'acquisition payante → groupe Telegram dzpk · source richads/<cre> · conversion mesurée hors système, via le report agent du club"
      />
      <RichAdsClient stats={stats} destConfigured={getDestUrl() !== null} />
    </>
  );
}
