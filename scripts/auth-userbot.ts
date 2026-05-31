import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const apiId = parseInt(process.env.TELEGRAM_API_ID!);
const apiHash = process.env.TELEGRAM_API_HASH!;
const phone = process.env.PHONE!;
const code = process.env.CODE!;
const password = process.env.PASSWORD!;

async function main() {
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => Promise.resolve(phone),
    phoneCode: () => Promise.resolve(code),
    password: () => Promise.resolve(password),
    onError: (err) => console.error("Auth error:", err.message),
  });

  const session = client.session.save() as unknown as string;
  console.log("SESSION=" + session);
  await client.disconnect();
}

main().catch(console.error);
