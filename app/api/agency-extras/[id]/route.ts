import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { amount, description, notes } = body;

  const existing = getDb().prepare(`SELECT * FROM agency_extras WHERE id = ? AND deleted_at IS NULL`).get(Number(id));
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }

  const updates: string[] = [];
  const vals: any[] = [];
  if (amount !== undefined) { updates.push("amount = ?"); vals.push(amount); }
  if (description !== undefined) { updates.push("description = ?"); vals.push(description); }
  if (notes !== undefined) { updates.push("notes = ?"); vals.push(notes); }

  if (updates.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  vals.push(Number(id));
  getDb().prepare(`UPDATE agency_extras SET ${updates.join(", ")} WHERE id = ?`).run(...vals);

  const row = getDb().prepare(`SELECT * FROM agency_extras WHERE id = ?`).get(Number(id));
  return NextResponse.json(row);
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = getDb().prepare(`SELECT * FROM agency_extras WHERE id = ? AND deleted_at IS NULL`).get(Number(id));
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  getDb().prepare(`UPDATE agency_extras SET deleted_at = datetime('now') WHERE id = ?`).run(Number(id));
  return NextResponse.json({ ok: true });
}
