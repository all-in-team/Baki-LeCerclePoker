export const dynamic = "force-dynamic";
import { getApps } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import AppsClient from "./AppsClient";

export default function AppsPage() {
  const apps = getApps();
  return (
    <div>
      <PageHeader title="Poker Apps" subtitle="Your affiliate deals per platform" />
      <AppsClient initialApps={apps as Parameters<typeof AppsClient>[0]["initialApps"]} />
    </div>
  );
}
