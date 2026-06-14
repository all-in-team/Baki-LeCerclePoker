/**
 * Re-onboard fallback-victim leads via the EXISTING prod routes (no reimplemented logic):
 *   - POST /api/players            (create player row)
 *   - POST /api/admin/setup-player-group  (createPlayerGroup + update row, server-side)
 *   - Bot API sendMessage          (owner/ops alert, like the normal flow)
 *
 * Sequential, 8s delay between leads, idempotent (skips if a group already exists),
 * STOPS on the first failure. Run via `railway run` so prod env vars are injected:
 *   railway run npx -y tsx scripts/reonboard-leads.ts
 */

const BASE = "https://lecerclepoker-production.up.railway.app";
const APP_PASSWORD = process.env.APP_PASSWORD ?? "";
const ADMIN_TOKEN = process.env.ADMIN_RECONCILE_TOKEN ?? "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const AGENT_CHAT_ID = process.env.AGENT_TELEGRAM_CHAT_ID ?? "-4846690641";
const DIAG_KEY = "db-diag-20260518";

const LEADS = [
  { telegram_id: 393782368, name: "Павел Гапоненко", telegram_handle: "PavelHaponenko" },
  { telegram_id: 5937869732, name: "JB", telegram_handle: "jbapt22" },
  { telegram_id: 7762343336, name: "BBN Consulting", telegram_handle: "bbnconsult" },
  { telegram_id: 5371677110, name: "Wassim Derbali", telegram_handle: null as string | null },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function diagSql(sql: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/admin/db-diagnostic`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: DIAG_KEY, action: "run-sql", sql }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error("diag failed: " + JSON.stringify(j));
  return j.rows ?? [];
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: APP_PASSWORD }),
  });
  if (!res.ok) throw new Error("login failed: " + res.status);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/session=[^;]+/);
  if (!m) throw new Error("no session cookie in login response");
  return m[0];
}

async function ownerAlert(text: string) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: AGENT_CHAT_ID, text, parse_mode: "HTML" }),
  }).catch(() => {});
}

async function main() {
  if (!APP_PASSWORD || !ADMIN_TOKEN) throw new Error("Missing APP_PASSWORD / ADMIN_RECONCILE_TOKEN (run via railway run)");
  const cookie = await login();
  console.log("logged in.\n");

  const done: { name: string; group_id: string; invite: string; members: number }[] = [];

  for (const lead of LEADS) {
    console.log(`\n──── ${lead.name} (tg=${lead.telegram_id}) ────`);

    // 1) idempotency: existing player + group?
    const existing = await diagSql(
      `SELECT id, telegram_group_id FROM players WHERE telegram_id = ${lead.telegram_id}`
    );
    let playerId: number | null = null;
    if (existing.length) {
      if (existing[0].telegram_group_id) {
        console.log(`SKIP — already has group ${existing[0].telegram_group_id} (player #${existing[0].id})`);
        done.push({ name: lead.name, group_id: existing[0].telegram_group_id, invite: "(existing)", members: -1 });
        continue;
      }
      playerId = existing[0].id;
      console.log(`reuse existing player #${playerId} (no group yet)`);
    }

    // 2) create player row if needed
    if (!playerId) {
      const pr = await fetch(`${BASE}/api/players`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: lead.name, telegram_handle: lead.telegram_handle ?? undefined, tier: "B" }),
      });
      if (!pr.ok) throw new Error(`POST /api/players failed for ${lead.name}: ${pr.status} ${await pr.text()}`);
      playerId = (await pr.json()).id;
      console.log(`created player #${playerId}`);
    }

    // 3) setup-player-group (server-side createPlayerGroup + row update)
    const sg = await fetch(`${BASE}/api/admin/setup-player-group`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
      body: JSON.stringify({ player_id: playerId, telegram_id: lead.telegram_id, telegram_handle: lead.telegram_handle ?? undefined }),
    });
    const sgJson = await sg.json();
    if (!sg.ok || !sgJson.ok) {
      throw new Error(`setup-player-group FAILED for ${lead.name} (player #${playerId}): ${sg.status} ${JSON.stringify(sgJson)}`);
    }
    const g = sgJson.group;
    if (g.status !== "full_success") {
      throw new Error(`group NOT full_success for ${lead.name}: status=${g.status} failed=${JSON.stringify(g.failed_steps)} errors=${JSON.stringify(g.errors)}`);
    }
    console.log(`GROUP_OK ${lead.name} → chat_id=${g.chat_id} bot_promoted=${g.bot_promoted} topics=${Object.keys(g.topic_ids).length} invite=${g.invite_link}`);

    // 4) owner/ops alert (like the normal flow)
    await ownerAlert(
      `✅ <b>${lead.name} onboardé (re-onboard panne 13/06)</b>\n` +
      `🆔 <code>${lead.telegram_id}</code>\n` +
      `📦 Groupe : <code>${g.chat_id}</code>\n` +
      `🔗 Invite : ${g.invite_link}`
    );

    done.push({ name: lead.name, group_id: String(g.chat_id), invite: g.invite_link, members: Object.keys(g.topic_ids).length });

    if (lead !== LEADS[LEADS.length - 1]) { console.log("sleep 8s (anti-FLOOD)..."); await sleep(8000); }
  }

  console.log("\n\n===== RÉCAP =====");
  for (const d of done) console.log(`${d.name}: group=${d.group_id} invite=${d.invite}`);
  console.log("DONE_ALL count=" + done.length);
  process.exit(0);
}

main().catch((e) => { console.error("\n!!! STOPPED:", e?.message ?? e); process.exit(1); });
