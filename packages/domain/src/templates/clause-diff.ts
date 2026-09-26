/**
 * Écarts d'un contrat par rapport à son modèle (brief §4 : « l'application
 * conserve le diff par rapport au modèle et le signale en revue interne »).
 *
 * Comparaison par `key` (identifiant stable de clause) ; les corps sont
 * normalisés (espaces, casse des balises) pour qu'une différence purement
 * typographique ne soit pas présentée comme une dérogation.
 */
export interface TemplateClauseRef {
  readonly key: string;
  readonly title: string;
  readonly bodyHtml: string;
  readonly required?: boolean;
}

export interface ContractClauseRef {
  readonly key: string;
  readonly title: string;
  readonly bodyHtml: string;
}

export interface ClauseDiff {
  readonly added: { key: string; title: string }[];
  readonly removed: { key: string; title: string; required: boolean }[];
  readonly modified: { key: string; title: string; titleChanged: boolean; bodyChanged: boolean }[];
  /** Au moins une clause dérogatoire : à surligner en revue interne. */
  readonly hasDeviation: boolean;
  /** Une clause OBLIGATOIRE du modèle a été retirée. */
  readonly requiredRemoved: boolean;
}

const norm = (html: string) =>
  html
    .replace(/<\/?([a-z0-9]+)/gi, (m) => m.toLowerCase())
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();

export function diffClauses(template: readonly TemplateClauseRef[] | null, contract: readonly ContractClauseRef[]): ClauseDiff {
  if (!template) {
    // Contrat rédigé sans modèle : il n'y a pas de référence dont dévier.
    return { added: [], removed: [], modified: [], hasDeviation: false, requiredRemoved: false };
  }
  const tpl = new Map(template.map((c) => [c.key, c]));
  const cur = new Map(contract.map((c) => [c.key, c]));
  const added = contract.filter((c) => !tpl.has(c.key)).map((c) => ({ key: c.key, title: c.title }));
  const removed = template
    .filter((t) => !cur.has(t.key))
    .map((t) => ({ key: t.key, title: t.title, required: !!t.required }));
  const modified = contract
    .filter((c) => tpl.has(c.key))
    .map((c) => {
      const t = tpl.get(c.key)!;
      return { key: c.key, title: c.title, titleChanged: t.title.trim() !== c.title.trim(), bodyChanged: norm(t.bodyHtml) !== norm(c.bodyHtml) };
    })
    .filter((m) => m.titleChanged || m.bodyChanged);
  return {
    added,
    removed,
    modified,
    hasDeviation: added.length + removed.length + modified.length > 0,
    requiredRemoved: removed.some((r) => r.required),
  };
}
