"use server";

import { revalidatePath } from "next/cache";
import { resolveGroupReviewCase } from "@/lib/queries/group-cases";

/**
 * Clôt un cas — trace de la décision, rien d'autre. Aucune action Telegram n'est
 * déclenchée d'ici : rattacher un groupe se fait avec `/linkgroup` dedans, créer un
 * groupe avec le bouton du funnel une fois l'identité corrigée. Ce bouton ne sert
 * qu'à vider la file de ce qui est traité.
 */
export async function resolveCaseAction(id: number, resolution: string, dismissed = false) {
  const ok = resolveGroupReviewCase(id, resolution, dismissed);
  revalidatePath("/group-cases");
  return ok ? { ok: true } : { ok: false, error: "Cas déjà clos ou introuvable" };
}
