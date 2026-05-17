import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { execSync } from "child_process";

let gitSha = "local-dev";
try { gitSha = readFileSync(".git-sha", "utf-8").trim(); } catch {}
if (gitSha === "local-dev") {
  try { gitSha = execSync("git rev-parse HEAD").toString().trim(); } catch {}
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  env: {
    BUILD_GIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA ?? gitSha,
    BUILD_TIME: new Date().toISOString(),
  },
  async redirects() {
    return [
      { source: "/tele", destination: "/akpoker/pnl", permanent: true },
      { source: "/settlements", destination: "/akpoker/settlements", permanent: true },
      { source: "/finance", destination: "/wepoker/pnl", permanent: true },
      { source: "/reports", destination: "/wepoker/settlements", permanent: true },
      { source: "/wallets", destination: "/akpoker/pnl", permanent: true },
    ];
  },
};

export default nextConfig;
