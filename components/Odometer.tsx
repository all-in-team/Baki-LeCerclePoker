"use client";

import { useEffect, useState, CSSProperties } from "react";

interface OdometerProps {
  value: number;
  durationMs?: number;   // total time incl. left→right stagger
  decimals?: number;
  signed?: boolean;      // force "+" on positive values
  suffix?: string;
  className?: string;
  style?: CSSProperties;
}

// Digits roll vertically and settle one by one, left → right.
// SSR renders all columns at 0; the transition fires on mount.
// prefers-reduced-motion disables the transition via .odo-track CSS.
export default function Odometer({
  value, durationMs = 1500, decimals = 0, signed = false, suffix = "", className = "", style,
}: OdometerProps) {
  const [run, setRun] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setRun(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const text = Math.abs(value).toLocaleString("fr-FR", {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
  const sign = value < 0 ? "-" : signed ? "+" : "";
  const chars = [...text];
  const nDigits = chars.filter(c => /\d/.test(c)).length;
  const stagger = nDigits > 1 ? Math.min(120, (durationMs * 0.45) / (nDigits - 1)) : 0;
  const roll = Math.max(300, durationMs - stagger * (nDigits - 1));

  let digitIdx = 0;
  return (
    <span className={`odo tabular-nums ${className}`} style={style} aria-label={`${sign}${text}${suffix}`}>
      {sign && <span>{sign}</span>}
      {chars.map((c, i) => {
        if (!/\d/.test(c)) return <span key={i} aria-hidden>{c}</span>;
        const d = Number(c);
        const idx = digitIdx++;
        const steps = 10 + d; // one full spin, then land on the digit
        // +1 extra digit below the target so the bounce overshoot shows a valid digit
        const track = Array.from({ length: steps + 2 }, (_, k) => k % 10);
        return (
          <span key={i} className="odo-col" aria-hidden>
            <span
              className="odo-track"
              style={{
                transform: run ? `translateY(-${steps}em)` : "translateY(0)",
                transitionDuration: `${roll}ms`,
                transitionDelay: `${idx * stagger}ms`,
              }}
            >
              {track.map((n, k) => <span key={k} className="odo-digit">{n}</span>)}
            </span>
          </span>
        );
      })}
      {suffix && <span aria-hidden>{suffix}</span>}
    </span>
  );
}
