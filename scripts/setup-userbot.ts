/**
 * One-time setup: generate a Telegram session string for auto-creating groups.
 *
 * Prerequisites:
 *   1. Go to https://my.telegram.org → API development tools
 *   2. Create an app → note down api_id and api_hash
 *
 * Usage:
 *   TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abc123 npx tsx scripts/setup-userbot.ts
 *
 * The script will ask for your phone number and a verification code.
 * Once done, it prints a SESSION STRING — add it to Railway as TELEGRAM_SESSION.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import * as readline from "readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "0");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";

  if (!apiId || !apiHash) {
    console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH env vars first.");
    console.error("Get them at https://my.telegram.org → API development tools");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => ask("Phone number (international format): "),
    password: () => ask("2FA password (if enabled): "),
    phoneCode: () => ask("Verification code: "),
    onError: (err) => console.error("Error:", err),
  });

  const session = client.session.save() as unknown as string;
  console.log("\n✅ Session generated. Add this to Railway:\n");
  console.log(`TELEGRAM_SESSION=${session}\n`);
  console.log("Also add:");
  console.log(`TELEGRAM_API_ID=${apiId}`);
  console.log(`TELEGRAM_API_HASH=${apiHash}`);

  await client.disconnect();
  rl.close();
}

main().catch(console.error);
