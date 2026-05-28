export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import SettlementsClient from "./SettlementsClient";

export default function SettlementsPage() {
  return (
    <>
      <PageHeader title="Settlements" subtitle="Grindhouse — calcul et paiement par grinder" />
      <SettlementsClient />
    </>
  );
}
