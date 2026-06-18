// Client-side eligibility WINDOW (relation level, display-only) — mirrors
// getEligibilityWindowStatus in lib/queries/affiliate.ts EXACTLY: the window is open while
// floor((now − relStart)/day) <= 30, and expires (last eligible day) = relStart + 30 days.
//
// Single source for the /crm/affiliates branches badge AND the agent drawer, so both always
// agree with the /crm/[id] line (Phase C, which calls getEligibilityWindowStatus server-side).
//
// NOTE: this is the RELATION-level onboarding window (one date per filleul) — distinct from the
// per-game `rate_label` (getCommissionRate: was that game's deal created within 30d of relStart),
// which is what actually gates the agency commission and can differ per game.
export function windowInfo(start_date: string): { open: boolean; expires: string } {
  const relStart = new Date(start_date + "T00:00:00Z");
  const daysSince = Math.floor((Date.now() - relStart.getTime()) / 86400000);
  const expires = new Date(relStart.getTime() + 30 * 86400000);
  return { open: daysSince <= 30, expires: expires.toISOString().slice(0, 10) };
}
