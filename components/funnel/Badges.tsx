// Badges partagés du tableau des leads (toutes rooms).
import type { VerificationState } from "@/lib/funnels/shared";
import { langLabel, coerceLang, DEFAULT_LANG } from "@/lib/i18n";

const BADGE: React.CSSProperties = {
  marginLeft: 6, fontSize: 10, padding: "2px 6px", borderRadius: 4,
  fontFamily: "inherit",
};

/**
 * ✓ VÉRIFIÉ dès que le Member ID apparaît dans un import hebdo (le compte existe
 * vraiment) ; ⏳ à vérifier sinon — un ID inventé le reste indéfiniment.
 * Rien n'est affiché tant qu'aucun ID n'a été fourni.
 */
export function VerifiedBadge({ state }: { state: VerificationState }) {
  if (state === "none") return null;
  if (state === "verified") {
    return (
      <span style={{ ...BADGE, background: "rgba(16,185,129,0.12)", color: "#10B981", fontWeight: 700 }}>
        ✓ VÉRIFIÉ
      </span>
    );
  }
  return (
    <span
      style={{ ...BADGE, background: "rgba(240,185,11,0.10)", color: "#F0B90B", fontWeight: 600 }}
      title="ID jamais vu dans un import — vérifié au prochain import hebdo, ou ID bidon"
    >
      ⏳ à vérifier
    </span>
  );
}

/** Le lead a du rake dans au moins un import → il joue vraiment. */
export function PlayedBadge() {
  return (
    <span style={{ ...BADGE, background: "rgba(16,185,129,0.12)", color: "#10B981", fontWeight: 700 }}>
      A JOUÉ
    </span>
  );
}

/** L'utilisateur a bloqué le bot → exclu des relances et des broadcasts. */
export function BlockedBadge() {
  return <span style={{ marginLeft: 6, fontSize: 10, color: "#F87171" }}>🚫 bot bloqué</span>;
}

/**
 * Langue du funnel. Le badge n'apparaît QUE si le lead a explicitement choisi une
 * langue non-défaut : un tableau où chaque ligne affiche « 🇫🇷 » n'apprend rien.
 * `chosenAt` NULL = lead créé avant le sélecteur → français implicite, pas de badge.
 */
export function LangBadge({ lang, chosenAt }: { lang: string; chosenAt: string | null }) {
  if (!chosenAt) return null;
  const code = coerceLang(lang);
  if (code === DEFAULT_LANG) return null;
  return (
    <span
      style={{ ...BADGE, background: "rgba(168,85,247,0.12)", color: "#C084FC", fontWeight: 600 }}
      title={`Funnel suivi en ${langLabel(code)}`}
    >
      {langLabel(code)}
    </span>
  );
}
