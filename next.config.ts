import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
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
