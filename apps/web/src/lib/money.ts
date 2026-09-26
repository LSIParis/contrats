/** « 1500,50 », « 1 500.50 » → 150050 centimes. Vide ou invalide → undefined. */
export function eurosToCents(v: string): number | undefined {
  const t = v.trim().replace(/[\s  ]/g, '').replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

/** 150050 → « 1500,50 » (valeur de champ de saisie, sans séparateur de milliers). */
export function centsToEurosInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/** 150050 → « 1 500,50 € » (affichage). */
export function formatEuros(cents: number): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}
