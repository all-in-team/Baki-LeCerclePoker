import { getDb } from "@/lib/db";

// ── Player aliases (display-only MVP) ────────────────────────────────────────
//
// Business rule (Baki): two players registering the SAME cashout wallet address are the
// same entity/team → group them under an alias and mix their results in the P&L views.
// This module is the DATA + DETECTION layer. It is display-only: it writes to the alias
// tables (player_aliases / player_alias_members) and reads player_wallet_cashouts. It does
// NOT touch wallet_transactions, deals, settlements, or any money math.
//
// Detection: union-find over shared cashout addresses (handles chaining A–B, B–C → {A,B,C}).
// Stability: a player already in an alias is NEVER moved automatically. Operator players
// (telegram_id ∈ OWNER_IDS) are excluded — an address shared with the operator is not a
// player team (e.g. Hugo/Baki on the legacy TELE address).

function operatorPlayerIds(): Set<number> {
  const ownerTgIds = (process.env.TELEGRAM_OWNER_IDS ?? "1298290355,1486389037")
    .split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (ownerTgIds.length === 0) return new Set();
  const placeholders = ownerTgIds.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT id FROM players WHERE telegram_id IN (${placeholders})`
  ).all(...ownerTgIds) as { id: number }[];
  return new Set(rows.map(r => r.id));
}

// Union-find helper.
class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let root = x;
    while (this.parent.get(root)! !== root) root = this.parent.get(root)!;
    // path compression
    let cur = x;
    while (this.parent.get(cur)! !== root) { const next = this.parent.get(cur)!; this.parent.set(cur, root); cur = next; }
    return root;
  }
  union(a: number, b: number) { this.parent.set(this.find(a), this.find(b)); }
  groups(): number[][] {
    const byRoot = new Map<number, number[]>();
    for (const x of this.parent.keys()) {
      const r = this.find(x);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r)!.push(x);
    }
    return [...byRoot.values()];
  }
}

export interface DetectAliasesResult {
  created: number;      // new aliases created
  extended: number;     // existing aliases that gained a member
  membersAdded: number; // total members inserted
  conflicts: number;    // groups spanning ≥2 existing aliases (left untouched — stability)
}

// Scan shared cashout addresses and upsert auto-aliases. Idempotent + stable: re-running
// only ADDS un-aliased players to a group; never moves an existing member.
export function detectAliases(): DetectAliasesResult {
  const db = getDb();
  const excluded = operatorPlayerIds();

  // (address, player_id) pairs, operator players removed.
  const rows = db.prepare(
    `SELECT DISTINCT address, player_id FROM player_wallet_cashouts`
  ).all() as { address: string; player_id: number }[];

  const byAddress = new Map<string, Set<number>>();
  for (const { address, player_id } of rows) {
    if (excluded.has(player_id)) continue;
    if (!byAddress.has(address)) byAddress.set(address, new Set());
    byAddress.get(address)!.add(player_id);
  }

  const uf = new UnionFind();
  for (const players of byAddress.values()) {
    const ids = [...players];
    if (ids.length < 2) continue; // not shared → no alias
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i]);
  }

  const result: DetectAliasesResult = { created: 0, extended: 0, membersAdded: 0, conflicts: 0 };

  const memberAlias = (pid: number) =>
    (db.prepare(`SELECT alias_id FROM player_alias_members WHERE player_id = ?`).get(pid) as { alias_id: number } | undefined)?.alias_id;

  const insertMember = db.prepare(`INSERT OR IGNORE INTO player_alias_members (alias_id, player_id) VALUES (?, ?)`);
  const nameOf = (pid: number) =>
    (db.prepare(`SELECT name FROM players WHERE id = ?`).get(pid) as { name: string } | undefined)?.name ?? `#${pid}`;

  const tx = db.transaction(() => {
    for (const group of uf.groups()) {
      if (group.length < 2) continue;
      const existing = [...new Set(group.map(memberAlias).filter((a): a is number => a !== undefined))];

      if (existing.length === 0) {
        // Brand-new alias — label after the lowest-id member (deterministic).
        const anchor = [...group].sort((a, b) => a - b)[0];
        const aliasId = Number(db.prepare(`INSERT INTO player_aliases (label) VALUES (?)`).run(`Alias — ${nameOf(anchor)}`).lastInsertRowid);
        for (const pid of group) { if (insertMember.run(aliasId, pid).changes > 0) result.membersAdded++; }
        result.created++;
      } else if (existing.length === 1) {
        // Extend the single existing alias with any un-aliased members.
        const aliasId = existing[0];
        let added = 0;
        for (const pid of group) { if (memberAlias(pid) === undefined && insertMember.run(aliasId, pid).changes > 0) added++; }
        if (added > 0) { result.extended++; result.membersAdded += added; }
      } else {
        // Group spans multiple existing aliases — do NOT auto-merge (stability). Baki decides.
        result.conflicts++;
      }
    }
  });
  tx();
  return result;
}

export interface AliasInfo { alias_id: number; label: string; member_ids: number[] }

// alias membership for a set of players → { player_id: {alias_id, label, member_ids} }.
// Only players that belong to an alias appear in the map.
export function getAliasesForPlayers(playerIds: number[]): Record<number, AliasInfo> {
  if (playerIds.length === 0) return {};
  const db = getDb();
  const ph = playerIds.map(() => "?").join(",");
  const memberAliasIds = db.prepare(
    `SELECT DISTINCT alias_id FROM player_alias_members WHERE player_id IN (${ph})`
  ).all(...playerIds) as { alias_id: number }[];
  if (memberAliasIds.length === 0) return {};

  const aliasIds = memberAliasIds.map(r => r.alias_id);
  const aph = aliasIds.map(() => "?").join(",");
  const aliases = db.prepare(`SELECT id, label FROM player_aliases WHERE id IN (${aph})`).all(...aliasIds) as { id: number; label: string }[];
  const members = db.prepare(`SELECT alias_id, player_id FROM player_alias_members WHERE alias_id IN (${aph})`).all(...aliasIds) as { alias_id: number; player_id: number }[];

  const membersByAlias = new Map<number, number[]>();
  for (const m of members) {
    if (!membersByAlias.has(m.alias_id)) membersByAlias.set(m.alias_id, []);
    membersByAlias.get(m.alias_id)!.push(m.player_id);
  }
  const labelById = new Map(aliases.map(a => [a.id, a.label]));

  const out: Record<number, AliasInfo> = {};
  for (const m of members) {
    out[m.player_id] = {
      alias_id: m.alias_id,
      label: labelById.get(m.alias_id) ?? `Alias #${m.alias_id}`,
      member_ids: membersByAlias.get(m.alias_id) ?? [m.player_id],
    };
  }
  return out;
}

// Owner rename. Returns false if the alias does not exist or the label is empty.
export function updateAliasLabel(aliasId: number, label: string): boolean {
  const clean = label.trim().slice(0, 80);
  if (!clean) return false;
  const r = getDb().prepare(`UPDATE player_aliases SET label = ? WHERE id = ?`).run(clean, aliasId);
  return r.changes > 0;
}
