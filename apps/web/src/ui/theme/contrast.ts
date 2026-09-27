/**
 * Calcul du rapport de contraste WCAG 2.x entre deux couleurs hexadécimales opaques.
 * Référence : https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio (formule de luminance relative).
 * Utilisé par les tests d'accessibilité (RGAA critère 3.2 / WCAG 1.4.3 : ≥ 4,5:1 pour le texte).
 */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`Couleur hexadécimale invalide : ${hex}`);
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
