import { z } from 'zod';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';

/**
 * Description riche (HTML) des codes de la grille tarifaire, des lignes de
 * proposition et des lignes de barème (13-types-contrats.md §3).
 *
 * Entrée utilisateur rendue telle quelle (interface, page publique, PDF) :
 * ASSAINIE à l'écriture avec la liste blanche des contrats (titres, gras,
 * listes, liens, tableaux simples). Un texte sans balise reste du texte.
 * La limite porte sur le HTML assaini.
 */
export const MAX_DESCRIPTION_LENGTH = 20_000;

const EMPTY = /^(?:\s|<p>\s*<\/p>|<br\s*\/?>)*$/i;

export function sanitizeDescription(html: string): string {
  const clean = sanitizeContractHtml(html).trim();
  return EMPTY.test(clean) ? '' : clean;
}

/** Chaîne HTML assainie ; vide → null. */
export const HtmlDescription = z
  .string()
  .max(MAX_DESCRIPTION_LENGTH * 2, `description trop longue (au plus ${MAX_DESCRIPTION_LENGTH} caractères)`)
  .transform(sanitizeDescription)
  .pipe(z.string().max(MAX_DESCRIPTION_LENGTH, `description trop longue (au plus ${MAX_DESCRIPTION_LENGTH} caractères)`))
  .transform((s) => (s === '' ? null : s));
