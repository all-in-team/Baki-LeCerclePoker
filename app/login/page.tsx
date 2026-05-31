"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";

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
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0a" }}>
      <form onSubmit={handleSubmit} style={{ width: 340, padding: 32, borderRadius: 12, background: "#111", border: "1px solid #222" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: "linear-gradient(135deg, #22C55E, #D4AF37)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 800, color: "#000",
          }}>&#9824;</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Le Cercle Poker</div>
            <div style={{ fontSize: 10, color: "#D4AF37", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Admin</div>
          </div>
        </div>

        <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
          Mot de passe
        </label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoFocus
          placeholder="..."
          style={{
            width: "100%", padding: "10px 14px", borderRadius: 8, fontSize: 14,
            background: "#0a0a0a", color: "#fff", border: "1px solid #333",
            outline: "none", boxSizing: "border-box", marginBottom: 14,
          }}
        />

        {error && (
          <div style={{ padding: "8px 12px", borderRadius: 6, marginBottom: 14, fontSize: 12, fontWeight: 600, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#EF4444" }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            width: "100%", padding: "10px 0", borderRadius: 8, fontSize: 13, fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E",
            opacity: loading || !password ? 0.5 : 1,
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
