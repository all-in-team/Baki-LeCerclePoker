import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import * as fs from "fs";

const apiId = parseInt(process.env.TELEGRAM_API_ID!);
const apiHash = process.env.TELEGRAM_API_HASH!;
const phone = process.env.PHONE!;

async function main() {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phone,
      apiId,
      apiHash,
      settings: new Api.CodeSettings({}),
    })
  );

  // Save interim session + hash so verify-code can reuse the same connection state
  const interimSession = client.session.save() as unknown as string;
  fs.writeFileSync("/tmp/tg-auth-state.json", JSON.stringify({
    phoneCodeHash: result.phoneCodeHash,
    session: interimSession,
  }));

  console.log("PHONE_CODE_HASH=" + result.phoneCodeHash);
  console.log("STATE_SAVED=true");
  await client.disconnect();
}

main().catch(console.error);
