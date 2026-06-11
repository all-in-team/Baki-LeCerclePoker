export const dynamic = "force-dynamic";
import DashboardClient from "./DashboardClient";

// Page title comes from the Topbar ("Grindhouse — Dashboard") — no duplicate local header
export default function DashboardPage() {
  return <DashboardClient />;
}
