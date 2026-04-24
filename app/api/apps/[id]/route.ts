import { NextRequest, NextResponse } from "next/server";
import { updateApp, deleteApp } from "@/lib/queries";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  updateApp(Number(id), body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteApp(Number(id));
  return NextResponse.json({ ok: true });
}
