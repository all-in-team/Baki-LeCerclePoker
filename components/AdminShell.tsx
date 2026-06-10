"use client";

import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import Sidebar from "./Sidebar";
import { Menu } from "lucide-react";

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  if (pathname?.startsWith("/portal") || pathname?.startsWith("/login")) {
    return <>{children}</>;
  }

  return (
    <>
      <div
        style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 40,
          height: 56, padding: "0 16px",
          background: "rgba(10,9,20,0.72)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
        className="flex items-center lg:hidden"
      >
        <button
          onClick={() => setSidebarOpen(true)}
          style={{
            padding: 8, borderRadius: 8, background: "none", border: "none",
            color: "#8888A0", cursor: "pointer", display: "flex", alignItems: "center",
          }}
        >
          <Menu size={20} />
        </button>
        <div style={{ marginLeft: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: "linear-gradient(135deg, #10B981, #F5C518)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 800, color: "#000", letterSpacing: "-0.02em",
          }}>LC</div>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#E8E8EE" }}>Le Cercle</span>
        </div>
      </div>

      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 45,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
          }}
          className="lg:hidden"
        />
      )}

      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="pt-14 lg:pt-0 lg:ml-[260px]" style={{ flex: 1, minHeight: "100vh" }}>
        <div className="p-6 lg:p-10" style={{ maxWidth: 1400 }}>
          {children}
        </div>
      </main>
    </>
  );
}
