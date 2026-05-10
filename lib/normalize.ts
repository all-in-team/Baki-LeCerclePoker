export function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeForMatch(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/[^\w\s]/g, "").trim();
}
