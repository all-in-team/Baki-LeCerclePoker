export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import ExpensesClient from "./ExpensesClient";

export default function ExpensesPage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const expenses = db.prepare(`
    SELECT ge.*, p.name AS player_name FROM grindhouse_expenses ge LEFT JOIN players p ON p.id = ge.player_id
    WHERE ge.date = ? ORDER BY ge.created_at DESC
  `).all(today) as any[];

  const grinders = db.prepare(`SELECT gg.player_id, p.name FROM grindhouse_grinders gg JOIN players p ON p.id = gg.player_id WHERE gg.status = 'active' ORDER BY p.name`).all() as any[];

  return (
    <>
      <PageHeader title="Frais" subtitle="Grindhouse — dépenses quotidiennes" />
      <ExpensesClient initialExpenses={expenses} initialDate={today} grinders={grinders} />
    </>
  );
}
