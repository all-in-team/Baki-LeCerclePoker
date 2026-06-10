// Remounts on every navigation so the page-in transition replays.
// flex:1 — on shell-less pages (login) this div is a direct child of the
// flex body and must fill it, or the page's own centering collapses.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-page-in" style={{ flex: 1, minWidth: 0 }}>{children}</div>;
}
