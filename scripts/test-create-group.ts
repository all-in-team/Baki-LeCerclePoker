/**
 * 3b — End-to-end test of createPlayerGroup WITHOUT any DB writes.
 * Runs the exact userbot flow used by onboarding (CreateChat -> migrate supergroup
 * -> invite bot -> promote -> topics), then verifies members + title.
 *
 * Usage (env injected by `railway run`):
 *   railway run npx -y tsx scripts/test-create-group.ts
 *
 * Cleanup: the group is left in place for visual inspection. Delete it manually
 * in Telegram (you are creator), or run the delete step we prepare afterwards.
 */

import { createPlayerGroup, getChatMembers, listGroups } from "../lib/telegram-userbot";

const TEST_PLAYER_TG_ID = 1298290355; // @Baki77777 (self-test)
const TEST_NAME = "ZZ TEST3b DELETE";

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!botToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  console.log(`Creating test group "${TEST_NAME} x LeCercle" ...`);
  const result = await createPlayerGroup(TEST_PLAYER_TG_ID, TEST_NAME, botToken, "Baki77777");

  if (!result) {
    console.error("RESULT_NULL: createPlayerGroup returned null (userbot not connected / config).");
    process.exit(2);
  }

  console.log("=== createPlayerGroup RESULT ===");
  console.log(JSON.stringify({
    chatId: result.chatId,
    status: result.status,
    botPromoted: result.botPromoted,
    topicCount: Object.keys(result.topicIds).length,
    topicIds: result.topicIds,
    inviteLink: result.inviteLink,
    failedSteps: result.failedSteps,
    errors: result.errors,
  }, null, 2));

  // Verify members (bot + hugoroine + baki should be present)
  await new Promise((r) => setTimeout(r, 2000));
  const members = await getChatMembers(String(result.chatId));
  console.log("=== MEMBERS ===");
  console.log(JSON.stringify(members.map((m) => ({ id: m.id, username: m.username, name: m.first_name })), null, 2));

  // Verify title via listGroups
  const lg = await listGroups();
  const ours = lg.groups.find((g) => g.chat_id === String(result.chatId));
  console.log("=== TITLE CHECK ===");
  console.log(JSON.stringify({ found: !!ours, title: ours?.title ?? null, member_count: ours?.member_count ?? null }, null, 2));

  console.log("\nTEST_DONE chat_id=" + result.chatId);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(3);
});
