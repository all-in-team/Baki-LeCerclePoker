"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname?.startsWith("/portal") || pathname?.startsWith("/login")) {
    return <>{children}</>;
  }

  return (
    <>
      <Sidebar />
      <main style={{
        marginLeft: 220,
        flex: 1,
        padding: "32px 36px",
        minHeight: "100vh",
        background: "var(--bg-base)",
      }}>
        {children}
      </main>
    </>
  );
}
