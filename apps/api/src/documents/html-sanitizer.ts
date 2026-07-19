import sanitizeHtml from 'sanitize-html';

/**
 * Assainit le corps d'un contrat. (§6.4)
 *
 * bodyHtml est une entrée utilisateur qui sera rendue par un Chromium
 * (Gotenberg). Le rendu est sandboxé, mais on retire scripts et gestionnaires
 * d'événements À LA SOURCE — allowlist alignée sur les capacités de l'éditeur
 * (titres, gras/italique, listes, paragraphes, liens).
 */
export function sanitizeContractHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['h1', 'h2', 'h3', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'a'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}
