export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import DashboardClient from "./DashboardClient";

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Grindhouse — rentabilité et taux horaires" />
      <DashboardClient />
    </>
  );
}
