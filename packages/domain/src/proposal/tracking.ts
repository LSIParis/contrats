/**
 * Suivi de lecture — minimisation (brief §12.5, 08-securite-rgpd.md).
 *
 * L'adresse IP d'un lecteur est une donnée personnelle : pour le SUIVI, on
 * ne conserve qu'une IP TRONQUÉE (/24 en IPv4, /48 en IPv6), suffisante pour
 * repérer grossièrement un lien transféré, insuffisante pour identifier un
 * poste. (La preuve d'une acceptation par clic, elle, conserve l'IP complète :
 * autre finalité, autre base légale — voir 11-propositions.md §6.)
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim());
  if (v4) {
    const parts = v4.slice(1, 5).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  const s = ip.trim().toLowerCase();
  if (!/^[0-9a-f:]+$/.test(s) || !s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const full = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (full.length !== 8 || full.some((g) => g.length === 0 || g.length > 4)) return null;
  return `${full.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::`;
}
