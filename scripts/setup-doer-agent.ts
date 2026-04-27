/**
 * One-time setup for the doer agent.
 *
 * Creates an Anthropic Managed Agents environment + agent for LeCerclePoker.
 * Prints the IDs — caller is expected to push them to Railway env vars
 * (AGENT_DOER_ENV_ID, AGENT_DOER_AGENT_ID).
 *
 * Idempotent: pass --recreate to force new env+agent. Otherwise reads
 * existing IDs from .doer-ids.json (gitignored) and verifies they exist.
 *
 * Usage:
 *   bun scripts/setup-doer-agent.ts
 *   bun scripts/setup-doer-agent.ts --recreate
 */

import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error("❌ .env.local not found");
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const AGENT_NAME = "LeCerclePoker Doer";
const ENV_NAME = "lecercle-doer-env";
const IDS_FILE = ".doer-ids.json";

interface SavedIds {
  env_id?: string;
  agent_id?: string;
  agent_version?: number;
}

function loadIds(): SavedIds {
  if (!fs.existsSync(IDS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(IDS_FILE, "utf8")); } catch { return {}; }
}

function saveIds(ids: SavedIds) {
  fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2));
}

function readSystemPrompt(): string {
  const yamlPath = path.join(process.cwd(), ".claude/agent/lecercle-doer.agent.yaml");
  if (!fs.existsSync(yamlPath)) {
    return `Tu es l'agent de maintenance de LeCerclePoker.`;
  }
  const yamlContent = fs.readFileSync(yamlPath, "utf8");
  const sysMatch = yamlContent.match(/system:\s*\|\s*\n((?:  .+\n?|\n)+?)(?=\n[a-z_]+:|$)/);
  if (!sysMatch) return `Tu es l'agent de maintenance de LeCerclePoker.`;
  return sysMatch[1].split("\n").map(l => l.replace(/^  /, "")).join("\n").trim();
}

async function main() {
  loadEnv();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const recreate = process.argv.includes("--recreate");
  const ids: SavedIds = recreate ? {} : loadIds();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ── Environment ─────────────────────────────────────────
  let envId = ids.env_id;
  if (envId) {
    try {
      const env = await (client as any).beta.environments.retrieve(envId);
      console.log(`✅ Existing env: ${env.id} (${env.name})`);
    } catch {
      console.log(`⚠️  Env id stale, creating new one...`);
      envId = undefined;
    }
  }

  if (!envId) {
    console.log(`→ Creating environment "${ENV_NAME}"...`);
    const env = await (client as any).beta.environments.create({
      name: ENV_NAME,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    envId = env.id as string;
    console.log(`✅ Created env: ${envId}`);
  }

  // ── Agent ───────────────────────────────────────────────
  let agentId = ids.agent_id;
  let agentVersion = ids.agent_version;
  if (agentId) {
    try {
      const a = await (client as any).beta.agents.retrieve(agentId);
      console.log(`✅ Existing agent: ${a.id} (${a.name}, version ${a.version})`);
      agentVersion = a.version;
    } catch {
      console.log(`⚠️  Agent id stale, creating new one...`);
      agentId = undefined;
    }
  }

  if (!agentId) {
    console.log(`→ Creating agent "${AGENT_NAME}"...`);
    const systemPrompt = readSystemPrompt();
    const agent = await (client as any).beta.agents.create({
      name: AGENT_NAME,
      model: "claude-opus-4-7",
      description: "Maintenance + feature agent for LeCerclePoker. Triggered on-demand from Telegram.",
      system: systemPrompt,
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        },
      ],
    });
    agentId = agent.id as string;
    agentVersion = agent.version as number;
    console.log(`✅ Created agent: ${agentId} (version ${agentVersion})`);
  }

  saveIds({ env_id: envId, agent_id: agentId, agent_version: agentVersion });

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Setup OK. IDs saved to .doer-ids.json (gitignored).");
  console.log("");
  console.log("To activate in production, run:");
  console.log(`  railway variables --set "AGENT_DOER_ENV_ID=${envId}" --set "AGENT_DOER_AGENT_ID=${agentId}"`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch(e => {
  console.error("Setup failed:", e?.message ?? e);
  if (e?.error) console.error(JSON.stringify(e.error, null, 2));
  process.exit(1);
});
