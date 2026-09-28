import { describe, test, expect } from 'vitest';
import { VARIABLE_REGISTRY, extractVariables } from '@lsi/domain';
import { sanitizeContractHtml } from '../../src/documents/html-sanitizer.js';
import { ALL_CLAUSES, CONTRACT_TEMPLATES } from '../../../../packages/persistence/src/seed/contract-templates-data.js';

/** Contrats types des propositions : compatibles avec le moteur de contenu structuré. */
describe('contrats types des propositions', () => {
  const texts = [...ALL_CLAUSES.map((c) => c.bodyHtml), ...CONTRACT_TEMPLATES.flatMap((t) => t.annexes.map((a) => a.bodyHtml ?? ''))];

  test('uniquement des variables du registre (sinon les contrats générés seraient refusés)', () => {
    const used = new Set(texts.flatMap((h) => extractVariables(h)));
    for (const v of used) expect(Object.keys(VARIABLE_REGISTRY), v).toContain(v);
  });

  test('HTML déjà conforme au nettoyeur : rien n’est perdu à l’enregistrement', () => {
    for (const h of texts) expect(sanitizeContractHtml(h)).toBe(h);
  });
});
