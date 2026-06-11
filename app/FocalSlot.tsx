import FigurineDuo from "./FigurineDuo";

// Focal zone on the right of the hero: the two figurines on a turntable,
// anchored by a soft gold ground-glow disc. No text may ever depend on
// this zone — if WebGL or the models are unavailable, only the disc remains.
export default function FocalSlot() {
  return (
    <div
      aria-hidden
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 260, pointerEvents: "none" }}
    >
      <div style={{
        position: "absolute", left: "50%", bottom: 18, transform: "translateX(-50%)",
        width: "72%", height: 44,
        background: "radial-gradient(ellipse 50% 50% at 50% 50%, rgba(240,185,11,0.06), transparent 70%)",
        filter: "blur(2px)",
      }} />
      <FigurineDuo />
    </div>
  );
}
