/**
 * Regenerate the userbot session WITHOUT manual copy-paste.
 *
 * Logs in interactively (phone -> code -> 2FA), then:
 *   - prints the logged-in @username so you can confirm it's the right account
 *   - writes ONLY the session string (no prompts, no newline noise) to $SESSION_OUT
 *
 * The session never touches your clipboard. A separate step reads $SESSION_OUT
 * and pushes it to Railway, eliminating paste-corruption (cause #1).
 *
 * Usage (api_id/api_hash injected by `railway run`):
 *   SESSION_OUT=/tmp/lcp_sess.txt railway run npx -y tsx scripts/regen-userbot-session.ts
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import * as readline from "readline";
import * as fs from "fs";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  const out = process.env.SESSION_OUT ?? "";

  if (!apiId || !apiHash) {
    console.error("Missing TELEGRAM_API_ID / TELEGRAM_API_HASH (run via `railway run`).");
    process.exit(1);
  }
  if (!out) {
    console.error("Missing SESSION_OUT env var (where to write the session file).");
    process.exit(1);
  }

  console.log(`Using api_id=${apiId} (from Railway env)`);

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => ask("Phone number (international format, e.g. +33...): "),
    password: () => ask("2FA password (if enabled, else Enter): "),
    phoneCode: () => ask("Verification code from Telegram: "),
    onError: (err) => console.error("Auth error:", err.message ?? err),
  });

  // Confirm WHICH account we authenticated as (cause #3 diagnosis)
  const me = (await client.getMe()) as any;
  console.log(`\n✅ Logged in as: @${me.username ?? "(no username)"}  id=${me.id}  name=${me.firstName ?? ""}`);

  const session = client.session.save() as unknown as string;
  // Write the raw session, no trailing newline, owner-only perms
  fs.writeFileSync(out, session, { encoding: "utf8", mode: 0o600 });
  console.log(`✅ Session written to ${out} (${session.length} chars). It was NOT printed here.`);

  await client.disconnect();
  rl.close();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
