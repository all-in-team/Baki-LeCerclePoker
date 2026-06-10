"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import { Lock } from "lucide-react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") || "/";
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push(from);
        router.refresh();
      } else {
        setError("Mot de passe incorrect");
        setPassword("");
      }
    } catch {
      setError("Erreur de connexion");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0A0B0E", position: "relative", overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        width: 600, height: 600, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(16,185,129,0.06) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      <form onSubmit={handleSubmit} className="animate-fade-in" style={{
        width: 380, padding: 36, borderRadius: 20,
        background: "rgba(18, 20, 24, 0.7)",
        backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 32px 64px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.03)",
        position: "relative", zIndex: 1,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 14,
            background: "linear-gradient(135deg, #10B981, #F5C518)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 20, fontWeight: 800, color: "#000",
            boxShadow: "0 8px 24px rgba(16,185,129,0.2)",
          }}>&#9824;</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#E8E8EE", lineHeight: 1.2 }}>Le Cercle Poker</div>
            <div style={{ fontSize: 11, color: "#F5C518", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Admin</div>
          </div>
        </div>

        <label style={{
          display: "block", fontSize: 11, fontWeight: 700, color: "#8888A0",
          textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8,
        }}>
          Mot de passe
        </label>
        <div style={{ position: "relative", marginBottom: 16 }}>
          <Lock size={16} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#555568" }} />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            placeholder="..."
            style={{
              width: "100%", padding: "11px 14px 11px 38px", borderRadius: 10, fontSize: 14,
              background: "rgba(255,255,255,0.04)", color: "#E8E8EE",
              border: "1px solid rgba(255,255,255,0.08)",
              outline: "none", boxSizing: "border-box",
              transition: "border-color 0.15s, box-shadow 0.15s",
            }}
          />
        </div>

        {error && (
          <div style={{
            padding: "8px 12px", borderRadius: 8, marginBottom: 16,
            fontSize: 12, fontWeight: 600,
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#EF4444",
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            width: "100%", padding: "11px 0", borderRadius: 10, fontSize: 13, fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            background: "linear-gradient(135deg, #10B981, #047857)",
            border: "none", color: "#fff",
            opacity: loading || !password ? 0.5 : 1,
            transition: "opacity 0.15s, box-shadow 0.15s",
            boxShadow: "0 4px 16px rgba(16,185,129,0.2)",
          }}
        >
          {loading ? "..." : "Connexion"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
