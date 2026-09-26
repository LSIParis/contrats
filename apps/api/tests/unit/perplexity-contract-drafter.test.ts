import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PseudonymizationLeakError } from '@lsi/domain';
import { PerplexityContractDrafter, FRENCH_LEGAL_DOMAINS, type PerplexityDrafterOptions } from '../../src/ai-drafting/perplexity-contract-drafter.js';
import {
  AiAuthError,
  AiBadRequestError,
  AiNotConfiguredError,
  AiRateLimitError,
  AiSchemaViolationError,
  AiTimeoutError,
  AiUpstreamError,
  toHttpException,
} from '../../src/ai-drafting/drafting-errors.js';
import type { StructuredDraftInput } from '../../src/ai-drafting/contract-drafting-provider.port.js';
import { pseudonymizeDraftInput, reidentifyDeep } from '../../src/ai-drafting/drafting-pseudonymization.js';
import { buildDraftTask } from '../../src/ai-drafting/drafting-prompts.js';

// Fixtures à la racine du dépôt (test/fixtures/perplexity), emplacement imposé par le brief.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'test', 'fixtures', 'perplexity');

interface HttpFixture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as HttpFixture;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Double de `fetch` : rejoue des réponses dans l'ordre, enregistre les requêtes. AUCUN réseau. */
function stubFetch(responses: (HttpFixture | 'hang' | 'network-error')[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error('stubFetch : plus de réponse prévue');
    if (next === 'network-error') throw new TypeError('fetch failed');
    if (next === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });
    }
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status, headers: next.headers });
  }) as typeof fetch;
  return { impl, calls };
}

function drafter(responses: Parameters<typeof stubFetch>[0], opts: Partial<PerplexityDrafterOptions> = {}) {
  const f = stubFetch(responses);
  const d = new PerplexityContractDrafter({ apiKey: 'pplx-test-key', fetch: f.impl, defaultSelection: { preset: 'medium' }, ...opts });
  return { d, calls: f.calls };
}

const INPUT: StructuredDraftInput = {
  contractType: 'Infogérance',
  needs: 'Infogérance complète du parc de [CLIENT] : 40 postes, 3 serveurs, redevance [MONTANT_1] HT par mois.',
  services: ['Supervision 24/7', 'Sauvegarde externalisée', 'Support utilisateurs'],
};

/** Enveloppe minimale « completed » autour d'un JSON de sortie. */
function envelopeWith(data: unknown): HttpFixture {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      id: 'resp_x',
      object: 'response',
      created_at: 1,
      model: 'openai/gpt-5.6-terra',
      status: 'completed',
      output: [{ id: 'msg_x', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(data), annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };
}

describe('Perplexity — requête (contrat HTTP vérifié)', () => {
  test('POST {base}/v1/agent, Bearer, outils, response_format json_schema, preset du tenant', async () => {
    const { d, calls } = drafter([fixture('success.json')]);
    await d.draftStructured({ ...INPUT, selection: { preset: 'high' } });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe('https://api.perplexity.ai/v1/agent');
    expect(c.headers.authorization).toBe('Bearer pplx-test-key');
    expect(c.body.preset).toBe('high');
    expect(c.body).not.toHaveProperty('model');
    expect(c.body.tools).toEqual([
      { type: 'web_search', filters: { search_domain_filter: [...FRENCH_LEGAL_DOMAINS] } },
      { type: 'fetch_url' },
    ]);
    const rf = c.body.response_format as { type: string; json_schema: { name: string; schema: Record<string, unknown>; strict: boolean } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toMatch(/^[A-Za-z0-9_]{1,64}$/);
    expect(rf.json_schema.schema.type).toBe('object');
    expect(rf.json_schema.schema).not.toHaveProperty('$schema');
    expect(c.body.language_preference).toBe('fr');
    expect(c.body.store).toBe(false);
    expect(String(c.body.instructions)).toMatch(/Légifrance/);
    expect(String(c.body.instructions)).toMatch(/CNIL/);
    expect(String(c.body.instructions)).toMatch(/ANSSI/);
    expect(String(c.body.input)).toContain('[CLIENT]');
  });

  test('modèle choisi par le tenant (model + preset combinables), aucun modèle codé en dur', async () => {
    const { d, calls } = drafter([fixture('success.json'), fixture('success.json')]);
    await d.draftStructured({ ...INPUT, selection: { model: 'anthropic/claude-sonnet-4-6' } });
    expect(calls[0]!.body.model).toBe('anthropic/claude-sonnet-4-6');
    expect(calls[0]!.body).not.toHaveProperty('preset');
    expect(calls[0]!.body.max_output_tokens).toBe(8192);
    await d.draftStructured({ ...INPUT, selection: { model: 'openai/gpt-5.6-terra', preset: 'low' } });
    expect(calls[1]!.body).toMatchObject({ model: 'openai/gpt-5.6-terra', preset: 'low' });
  });

  test('ni model ni preset : refus AVANT tout appel réseau', async () => {
    const { d, calls } = drafter([], { defaultSelection: {} });
    await expect(d.draftStructured(INPUT)).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  test('PERPLEXITY_BASE_URL configurable (barre finale tolérée)', async () => {
    const { d, calls } = drafter([fixture('success.json')], { baseUrl: 'https://proxy.interne.example/pplx/' });
    await d.draftStructured(INPUT);
    expect(calls[0]!.url).toBe('https://proxy.interne.example/pplx/v1/agent');
  });

  test('filtre de domaines désactivable', async () => {
    const { d, calls } = drafter([fixture('success.json')], { searchDomainFilter: null });
    await d.draftStructured(INPUT);
    expect((calls[0]!.body.tools as unknown[])[0]).toEqual({ type: 'web_search' });
  });

  test('clé absente : l’adaptateur refuse de se construire', () => {
    expect(() => new PerplexityContractDrafter({ apiKey: '' })).toThrow(AiNotConfiguredError);
  });
});

describe('Perplexity — réponse nominale', () => {
  test('clauses validées, sources issues des métadonnées uniquement, usage et coût', async () => {
    const { d } = drafter([fixture('success.json')]);
    const r = await d.draftStructured(INPUT);
    expect(r.provider).toBe('perplexity');
    expect(r.model).toBe('openai/gpt-5.6-terra');
    expect(r.clauses).toHaveLength(4);
    expect(r.clauses[0]).toMatchObject({ title: 'Objet', category: 'OBJET', riskLevel: 'LOW', removedUrls: [] });
    expect(r.clauses[2]!.text).toContain('[MONTANT_1]');
    expect(r.suggestedAnnexes).toHaveLength(2);
    expect(r.data.clauses).toBe(r.clauses);

    expect(r.sources.map((s) => [s.origin, s.url])).toEqual([
      ['search_result', 'https://www.cnil.fr/fr/sous-traitance-exemple-de-clauses'],
      ['search_result', 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032041559'],
      ['search_result', 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032226842'],
      ['fetch_url', 'https://cyber.gouv.fr/publications/guide-dhygiene-informatique'],
      ['citation', 'https://www.economie.gouv.fr/dgccrf/Publications/Vie-pratique/Fiches-pratiques/Delais-de-paiement'],
    ]);
    expect(r.sources[0]!.snippet).toMatch(/article 28/);

    expect(r.usage).toEqual({
      inputTokens: 9120,
      outputTokens: 1874,
      costUsd: 0.06072,
      toolInvocations: { search_web: 2, fetch_url: 1 },
    });
    expect(r.warnings).toEqual([]);
    // Archive d'audit : la requête exacte (sans clé) et la réponse brute.
    expect(JSON.stringify(r.raw.request)).not.toContain('pplx-test-key');
    expect((r.raw.response as { id: string }).id).toBe('resp_0f5e2c1a-7b39-4c61-9d7e-3a2b1c0d9e8f');
  });
});

describe('Perplexity — erreurs typées, jamais de brouillon partiel', () => {
  test('401 → AiAuthError (non réessayable)', async () => {
    const { d } = drafter([fixture('error-401.json')]);
    const err = await d.draftStructured(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiAuthError);
    expect((err as AiAuthError).retryable).toBe(false);
    expect((err as Error).message).toContain('Invalid API key');
    expect((err as Error).message).not.toContain('pplx-test-key');
  });

  test('422 → AiBadRequestError', async () => {
    const { d } = drafter([fixture('error-422.json')]);
    await expect(d.draftStructured(INPUT)).rejects.toBeInstanceOf(AiBadRequestError);
  });

  test('429 → AiRateLimitError avec Retry-After', async () => {
    const { d } = drafter([fixture('error-429.json')]);
    const err = (await d.draftStructured(INPUT).catch((e: unknown) => e)) as AiRateLimitError;
    expect(err).toBeInstanceOf(AiRateLimitError);
    expect(err.retryAfterSeconds).toBe(12);
    expect(err.retryable).toBe(true);
  });

  test('5xx et erreur réseau → AiUpstreamError', async () => {
    const { d } = drafter([{ status: 503, headers: {}, body: 'upstream down' }, 'network-error']);
    await expect(d.draftStructured(INPUT)).rejects.toBeInstanceOf(AiUpstreamError);
    await expect(d.draftStructured(INPUT)).rejects.toBeInstanceOf(AiUpstreamError);
  });

  test('JSON non conforme au schéma → AiSchemaViolationError avec le détail', async () => {
    const { d } = drafter([fixture('schema-violation.json')]);
    const err = (await d.draftStructured(INPUT).catch((e: unknown) => e)) as AiSchemaViolationError;
    expect(err).toBeInstanceOf(AiSchemaViolationError);
    expect(err.issues.join('\n')).toMatch(/riskLevel/);
    expect(err.issues.join('\n')).toMatch(/justification/);
  });

  test('génération incomplète (JSON tronqué) → AiSchemaViolationError', async () => {
    const { d } = drafter([fixture('truncated-json.json')]);
    await expect(d.draftStructured(INPUT)).rejects.toBeInstanceOf(AiSchemaViolationError);
  });

  test('corps non JSON ou sortie non JSON → AiSchemaViolationError', async () => {
    const notJsonOutput = envelopeWith('x');
    ((notJsonOutput.body as { output: { content: { text: string }[] }[] }).output[0]!.content[0]!).text = 'Voici votre contrat : …';
    const { d } = drafter([{ status: 200, headers: {}, body: '<html>proxy</html>' }, notJsonOutput]);
    await expect(d.draftStructured(INPUT)).rejects.toBeInstanceOf(AiSchemaViolationError);
    await expect(d.draftStructured(INPUT)).rejects.toBeInstanceOf(AiSchemaViolationError);
  });

  test('statut « failed » → AiUpstreamError', async () => {
    const failed = envelopeWith({});
    Object.assign(failed.body as object, { status: 'failed', error: { message: 'model overloaded' } });
    const { d } = drafter([failed]);
    await expect(d.draftStructured(INPUT)).rejects.toThrow(/model overloaded/);
  });

  test('traduction HTTP des erreurs typées', () => {
    expect(toHttpException(new AiAuthError('x', 'perplexity', 401)).getStatus()).toBe(503);
    expect(toHttpException(new AiTimeoutError('x', 'perplexity', 1000)).getStatus()).toBe(504);
    expect(toHttpException(new AiSchemaViolationError('x', 'perplexity')).getStatus()).toBe(502);
    expect(toHttpException(new PseudonymizationLeakError([{ kind: 'EMAIL', source: 'pattern', offset: 0 }])).getStatus()).toBe(503);
  });
});

describe('Perplexity — délai long au premier appel d’un nouveau schéma', () => {
  test('timeout.json : premier appel → délai « nouveau schéma », puis délai court une fois le schéma vu', async () => {
    expect((fixture('timeout.json') as unknown as { scenario: string }).scenario).toBe('timeout');
    const { d } = drafter(['hang', fixture('success.json'), 'hang'], { timeoutMs: 20, firstSchemaTimeoutMs: 60 });
    const schema = buildDraftTask(INPUT).jsonSchema;

    const first = (await d.draftStructured(INPUT).catch((e: unknown) => e)) as AiTimeoutError;
    expect(first).toBeInstanceOf(AiTimeoutError);
    expect(first.timeoutMs).toBe(60);
    // Un échec ne marque pas le schéma comme préparé.
    expect(d.hasSeenSchema(schema)).toBe(false);

    await d.draftStructured(INPUT);
    expect(d.hasSeenSchema(schema)).toBe(true);

    const later = (await d.draftStructured(INPUT).catch((e: unknown) => e)) as AiTimeoutError;
    expect(later).toBeInstanceOf(AiTimeoutError);
    expect(later.timeoutMs).toBe(20);
  });
});

describe('Perplexity — politique des sources', () => {
  test('URL écrites dans le texte : retirées, signalées, jamais promues en sources', async () => {
    const { d } = drafter([fixture('hallucinated-url.json')]);
    const r = await d.draftStructured(INPUT);
    const all = r.clauses.map((c) => `${c.title} ${c.text} ${c.justification}`).join('\n');
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).not.toMatch(/www\./);
    expect(all).not.toMatch(/cnil\.fr/);
    expect(all).not.toContain('[web:3]');
    expect(all).toContain('[CLIENT]'); // nos jetons, eux, restent
    expect(r.clauses[1]!.removedUrls).toEqual(['https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI999999999999']);
    expect(r.clauses[3]!.removedUrls).toEqual(['www.cnil-modeles-clauses.fr/rgpd', 'cnil.fr/fr/modele']);
    expect(r.warnings.length).toBe(2);
    const urls = r.sources.map((s) => s.url).join('\n');
    expect(urls).not.toContain('LEGIARTI999999999999');
    expect(urls).not.toContain('cnil-modeles-clauses');
  });

  test('recherche activée mais aucune source : avertissement', async () => {
    const { d } = drafter([envelopeWith({ clauses: [{ title: 'Objet', text: 'Texte.', category: 'OBJET', riskLevel: 'LOW', justification: 'Usage.' }], suggestedAnnexes: [] })]);
    const r = await d.draftStructured(INPUT);
    expect(r.sources).toEqual([]);
    expect(r.warnings.join()).toMatch(/Aucune source/);
  });
});

describe('Perplexity — pseudonymisation', () => {
  const KNOWN = { clientNames: ['Acme Industrie'], persons: ['Claire Fontaine'], emails: ['c.fontaine@acme-industrie.fr'] };

  test('garde-fou : une entité connue non pseudonymisée bloque l’envoi (aucun appel réseau)', async () => {
    const { d, calls } = drafter([fixture('success.json')]);
    await expect(d.draftStructured({ ...INPUT, needs: 'Contrat pour Acme Industrie', knownEntities: KNOWN })).rejects.toBeInstanceOf(
      PseudonymizationLeakError,
    );
    expect(calls).toHaveLength(0);
  });

  test('garde-fou : un motif sensible (e-mail, montant) bloque même sans entité connue', async () => {
    const { d, calls } = drafter([fixture('success.json')]);
    await expect(d.draftStructured({ ...INPUT, services: ['Support : écrire à support@exemple.fr'] })).rejects.toBeInstanceOf(PseudonymizationLeakError);
    await expect(d.draftStructured({ ...INPUT, needs: 'Budget : 1 500 € HT par mois' })).rejects.toBeInstanceOf(PseudonymizationLeakError);
    expect(calls).toHaveLength(0);
  });

  test('parcours complet : rien de réel ne part, tout revient à la réidentification', async () => {
    const { d, calls } = drafter([fixture('success.json')]);
    const { input, map } = pseudonymizeDraftInput(
      {
        contractType: 'Infogérance',
        needs: 'Acme Industrie (contact Claire Fontaine, c.fontaine@acme-industrie.fr) veut une redevance de 1 250,00 € HT par mois.',
        services: ['Supervision des serveurs d’Acme Industrie'],
      },
      KNOWN,
      { preset: 'medium' },
    );
    const r = await d.draftStructured(input);
    const sent = JSON.stringify(calls[0]!.body);
    for (const secret of ['Acme', 'Fontaine', 'c.fontaine', '1 250']) expect(sent).not.toContain(secret);
    expect(sent).toContain('[CLIENT]');
    expect(sent).toContain('[MONTANT_1]');

    const draft = reidentifyDeep({ clauses: r.clauses, suggestedAnnexes: r.suggestedAnnexes }, map);
    expect(draft.clauses[0]!.text).toContain('pour le compte de Acme Industrie');
    expect(draft.clauses[2]!.text).toContain('redevance mensuelle de 1 250,00 € HT');
    expect(JSON.stringify(draft)).not.toMatch(/\[(CLIENT|MONTANT_1)\]/);
  });
});

describe('Perplexity — fonctions complémentaires', () => {
  const clause = { title: 'Responsabilité', text: 'La responsabilité du Prestataire est limitée aux dommages directs.', category: 'RESPONSABILITE' as const };

  test('rephraseClause « durcir » : recherche activée, clause nettoyée', async () => {
    const out = { clause: { ...clause, text: 'Plafonnée au montant annuel [MONTANT_1] (https://exemple.fr).', riskLevel: 'MEDIUM', justification: 'Article 1231-3 du Code civil.' }, changes: ['Plafond ajouté'] };
    const { d, calls } = drafter([envelopeWith(out)]);
    const r = await d.rephraseClause({ clause, mode: 'durcir' });
    expect(calls[0]!.body.tools).toBeDefined();
    expect(String(calls[0]!.body.instructions)).toMatch(/renforce la clause/i);
    expect(r.data.clause.text).toBe('Plafonnée au montant annuel [MONTANT_1].');
    expect(r.data.clause.removedUrls).toEqual(['https://exemple.fr']);
    expect(r.data.changes).toEqual(['Plafond ajouté']);
  });

  test('rephraseClause « reformuler » : consigne de portée inchangée, sans recherche', async () => {
    const out = { clause: { ...clause, riskLevel: 'LOW', justification: 'Reformulation.' }, changes: [] };
    const { d, calls } = drafter([envelopeWith(out)]);
    await d.rephraseClause({ clause, mode: 'reformuler' });
    expect(String(calls[0]!.body.instructions)).toMatch(/SANS en changer la portée/);
    expect(calls[0]!.body).not.toHaveProperty('tools');
  });

  test('explainClause : langage clair, sans outil de recherche', async () => {
    const { d, calls } = drafter([envelopeWith({ summary: 'Le prestataire ne paie que les dégâts directs.', keyPoints: ['Pas de préjudice indirect'], pointsOfAttention: [] })]);
    const r = await d.explainClause({ clause });
    expect(calls[0]!.body).not.toHaveProperty('tools');
    expect(r.data.summary).toMatch(/dégâts directs/);
  });

  test('compareClause : un id inventé est ramené à « aucun »', async () => {
    const out = { closestItemId: 'lib-999', similarity: 'EQUIVALENT', differences: [], recommendation: 'Retenir la version bibliothèque.' };
    const { d } = drafter([envelopeWith(out), envelopeWith({ ...out, closestItemId: 'lib-1' })]);
    const items = [{ id: 'lib-1', title: 'Responsabilité (standard)', text: 'Plafond : montant annuel.' }];
    const r1 = await d.compareClause({ clause, libraryItems: items });
    expect(r1.data.closestItemId).toBe('');
    expect(r1.warnings.join()).toMatch(/inconnu/);
    const r2 = await d.compareClause({ clause, libraryItems: items });
    expect(r2.data.closestItemId).toBe('lib-1');
  });

  test('detectMissingClauses', async () => {
    const out = { missing: [{ title: 'Réversibilité', category: 'REVERSIBILITE', reason: 'Absente du projet.', riskLevel: 'HIGH' }] };
    const { d, calls } = drafter([envelopeWith(out)]);
    const r = await d.detectMissingClauses({
      contractType: 'Infogérance',
      draftClauses: [clause],
      templateClauses: [clause, { title: 'Réversibilité', text: 'Le Prestataire assiste le Client en fin de contrat.' }],
    });
    expect(String(calls[0]!.body.input)).toContain('Réversibilité');
    expect(r.data.missing[0]).toMatchObject({ category: 'REVERSIBILITE', riskLevel: 'HIGH' });
  });
});
