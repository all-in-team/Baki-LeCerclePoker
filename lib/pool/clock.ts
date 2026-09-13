// « Maintenant » et « aujourd'hui » pour le pool — en HEURE MURALE, au format
// des horodatages du pool (YYYY-MM-DD HH:MM:SS).
//
// HYPOTHÈSE À CONFIRMER (cahier phase 3) : OkPay affiche les dates dans l'heure
// locale du téléphone de Baki, c'est-à-dire Europe/Paris — le même calendrier que
// celui dans lequel il relève les soldes AK le dimanche. Si un vrai message montre
// un autre fuseau (UTC+8 par exemple), c'est ICI, et seulement ici, qu'on change
// la zone : tout le reste compare des heures murales entre elles.
//
// Pourquoi pas UTC : Railway tourne en UTC ; « 18:00 » saisi par Baki à 18:00 Paris
// serait alors « dans le futur » jusqu'à 18:00 UTC (constat money-auditor, phase 2).
const ZONE = "Europe/Paris";

export function poolNow(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find(p => p.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

export function poolToday(d: Date = new Date()): string {
  return poolNow(d).slice(0, 10);
}
