export const dynamic = "force-dynamic";
import { getAllSettings } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import SettingsClient from "./SettingsClient";

export default function SettingsPage() {
  const settings = getAllSettings();
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Configuration globale — wallets TELE, clés API, paramètres sync"
      />
      <SettingsClient initialSettings={settings} />
    </>
  );
}
