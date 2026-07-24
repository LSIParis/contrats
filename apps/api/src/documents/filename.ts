/**
 * Nom de fichier sur pour l'en-tete Content-Disposition : ASCII, sans
 * guillemets ni caracteres de controle (pas d'injection d'en-tete). Les
 * accents sont translitteres (NFD + suppression des diacritiques).
 */
export function slugifyFilename(name: string, fallback = 'document'): string {
  const base = name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return base || fallback;
}
