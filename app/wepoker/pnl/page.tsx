export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import FinanceClient from "./FinanceClient";

export default function WepokerPnlPage() {
  return (
    <>
      <PageHeader title="WEPOKER — P&L" subtitle="Rakeback, insurance & winnings par joueur" />
      <FinanceClient />
    </>
  );
}
