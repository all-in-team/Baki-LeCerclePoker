export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import { getGroupReviewCases } from "@/lib/queries/group-cases";
import GroupCasesClient from "./GroupCasesClient";

export default function GroupCasesPage() {
  const cases = getGroupReviewCases("all");

  return (
    <>
      <PageHeader
        title="Groupes à trancher"
        subtitle="Rapprochements non prouvés — aucun groupe n'a été créé, la décision est manuelle"
      />
      <GroupCasesClient cases={cases} />
    </>
  );
}
