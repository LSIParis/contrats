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

// ---------------------------------------------------------------------------
// Montants de la tarification (lot 3) : l'API renvoie des CHAÎNES — centimes
// entiers (« 128867 ») et prix décimaux en euros (« 1288.666407 »). On les
// formate par manipulation de chaînes / BigInt, jamais par un flottant.
// ---------------------------------------------------------------------------

const groupInt = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** « 128867 » → « 1 288,67 € ». `signed` : « +5,00 € » pour un écart positif. */
export function formatCents(cents: string | bigint | null | undefined, opts?: { signed?: boolean }): string {
  if (cents == null || cents === '') return '—';
  let v: bigint;
  try {
    v = typeof cents === 'bigint' ? cents : BigInt(cents);
  } catch {
    return '—';
  }
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const euros = (abs / 100n).toString();
  const cc = (abs % 100n).toString().padStart(2, '0');
  const sign = neg ? '-' : opts?.signed && abs > 0n ? '+' : '';
  return `${sign}${groupInt(euros)},${cc} €`;
}

/** « 1288.666407 » → « 1 288,666407 » ; « 1250.000000 » → « 1 250,00 » (au moins 2 décimales). */
export function formatDecimal(dec: string | null | undefined, opts?: { minFraction?: number }): string {
  if (dec == null || dec === '') return '—';
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(dec.trim());
  if (!m) return dec;
  const min = opts?.minFraction ?? 2;
  let frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length < min) frac = frac.padEnd(min, '0');
  return `${m[1]}${groupInt(m[2] ?? '0')}${frac ? `,${frac}` : ''}`;
}

/** Prix décimal en euros → « 1 288,666407 € ». */
export function formatDecimalEuros(dec: string | null | undefined): string {
  const f = formatDecimal(dec);
  return f === '—' ? f : `${f} €`;
}

/**
 * Saisie → chaîne décimale de l'API (« 1 250,5 » → « 1250.5 »), sans
 * conversion numérique. Vide → undefined ; forme invalide → null.
 */
export function decimalFromInput(v: string, opts?: { signed?: boolean; maxFraction?: number }): string | undefined | null {
  const t = v.trim().replace(/[\s  ]/g, '').replace(',', '.');
  if (!t) return undefined;
  const max = opts?.maxFraction ?? 6;
  const re = new RegExp(`^${opts?.signed ? '-?' : ''}\\d{1,14}(\\.\\d{1,${max}})?$`);
  return re.test(t) ? t : null;
}

/** Chaîne décimale de l'API → valeur de champ (« 1250.5 » → « 1250,5 »). */
export function decimalToInput(v: string | null | undefined): string {
  return v == null ? '' : v.replace('.', ',');
}
