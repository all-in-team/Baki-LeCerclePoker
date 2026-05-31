import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import * as fs from "fs";

const apiId = parseInt(process.env.TELEGRAM_API_ID!);
const apiHash = process.env.TELEGRAM_API_HASH!;
const phone = process.env.PHONE!;
const code = process.env.CODE!;
// Read password from file to avoid shell escaping issues
const password = fs.readFileSync("/tmp/tg-2fa-password.txt", "utf-8").trim();

async function main() {
  const state = JSON.parse(fs.readFileSync("/tmp/tg-auth-state.json", "utf-8"));

  const client = new TelegramClient(new StringSession(state.session), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: state.phoneCodeHash,
        phoneCode: code,
      })
    );
  } catch (e: any) {
    if (e.errorMessage === "SESSION_PASSWORD_NEEDED") {
      console.log("2FA required, checking password...");
      const srpResult = await client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(srpResult, password);
      await client.invoke(new Api.auth.CheckPassword({ password: check }));
      console.log("2FA passed!");
    } else {
      throw e;
    }
  }

  const session = client.session.save() as unknown as string;
  console.log("SESSION=" + session);
  await client.disconnect();
}

main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
