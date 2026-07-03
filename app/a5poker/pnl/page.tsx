import { redirect } from "next/navigation";

// A5POKER P&L merged into A5NUTS (A5POKER + NUTSPK, same owner/wallets) — Tir 2.
// The standalone page is dead; everything lives at /a5nuts/pnl.
export default function A5POKERRedirect() {
  redirect("/a5nuts/pnl");
}
