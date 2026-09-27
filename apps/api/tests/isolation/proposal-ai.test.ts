import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adminScope, internalScope, withScope } from '@lsi/persistence';
import { seedProposalTemplates, seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { createTestApp } from '../support/app.js';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DRAFTING_REGISTRY } from '../../src/ai-drafting/ai-gateway.service.js';
import { DraftingProviderRegistry } from '../../src/ai-drafting/drafting-provider-registry.js';
import type { AiCallResult, ContractDraftingProvider } from '../../src/ai-drafting/contract-drafting-provider.port.js';

/**
 * Lot 9.9 — assistance IA à la rédaction d'une proposition : notes
 * pseudonymisées, recherche publique limitée à la raison sociale et au site,
 * sections « générées par IA » bloquant l'envoi jusqu'à validation humaine.
 */
const calls: { method: string; input: Record<string, unknown> }[] = [];
const env = <T>(data: T): AiCallResult<T> => ({
  data, sources: [{ url: 'https://annuaire-entreprises.data.gouv.fr/x', title: 'Annuaire des entreprises', origin: 'search_result' }],
  usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.01 }, provider: 'perplexity', model: 'fake', warnings: [], raw: { request: null, response: null },
});
const unused = async (): Promise<never> => { throw new Error('non utilisé'); };

class FakeProvider implements ContractDraftingProvider {
  readonly name = 'perplexity' as const;
  private log(method: string, input: object) {
    const { knownEntities: _k, ...outbound } = input as Record<string, unknown>;
    calls.push({ method, input: outbound });
  }
  draftStructured = unused; rephraseClause = unused; explainClause = unused; compareClause = unused;
  detectMissingClauses = unused; extractImportMetadata = unused;
  async researchCompany(i: Parameters<ContractDraftingProvider['researchCompany']>[0]) {
    this.log('research', i);
    return env({ sector: 'Commerce de détail', size: '12 salariés', summary: `${i.companyName} exploite trois magasins.`, recentNews: [] });
  }
  async draftProposalSections(i: Parameters<ContractDraftingProvider['draftProposalSections']>[0]) {
    this.log('draft', i);
    return env({
      sections: [
        { key: 'contexte' as const, title: 'Contexte', text: '[CLIENT] dispose de 50 postes.' },
        { key: 'enjeux' as const, title: 'Enjeux', text: 'Garantir la continuité de service de [CLIENT].' },
      ],
      pointsToVerify: ['Nombre de magasins à confirmer.'],
    });
  }
  async rephraseProposalText(i: Parameters<ContractDraftingProvider['rephraseProposalText']>[0]) {
    this.log('rephrase', i);
    return env({ text: `Texte clair pour [CLIENT].`, changes: ['phrases raccourcies'] });
  }
}

let app: INestApplication;
let fx: TwoCustomerFixture;
let customerName: string;
let id: string;
const AM = 'pai-am';
const http = () => request(app.getHttpServer());

async function flag(key: string, enabled: boolean) {
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.tenantFeatureFlag.upsert({
    where: { tenantId_key: { tenantId: fx.tenantId, key } },
    create: { tenantId: fx.tenantId, key, enabled, updatedAt: new Date() },
    update: { enabled },
  }));
}

beforeAll(async () => {
  const registry = new DraftingProviderRegistry({ PERPLEXITY_API_KEY: 'test' }, { perplexity: () => new FakeProvider() });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRAFTING_REGISTRY).useValue(registry).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  await seedProposalTemplates(fx.tenantSlug);
  await flag('contrats.proposals.enabled', true);
  await flag('contrats.ai.enabled', true);
  customerName = (await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) => tx.customer.findUnique({ where: { id: fx.customerA.id } })))!.name;
  const s = app.get(SessionService);
  await s.put({ sessionId: AM, userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'pai-reader', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['READER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  const r = await http().post('/v1/proposals').set('x-lsi-session', AM)
    .send({ customerId: fx.customerA.id, templateSlug: 'infogerance', mergeContext: { 'parc.nbPostes': 50, 'parc.nbServeurs': 2, 'parc.nbEquipementsReseau': 5 } }).expect(201);
  id = r.body.proposal.id;
});
beforeEach(() => { calls.length = 0; });

describe('rédaction assistée d’une proposition', () => {
  test('recherche publique : seules la raison sociale et l’adresse du site partent ; notes pseudonymisées', async () => {
    const r = await http().post(`/v1/proposals/${id}/ai/draft`).set('x-lsi-session', AM).send({
      notes: `Rendez-vous avec la gérante de ${customerName} : 50 postes, pas de sauvegarde externalisée.`,
      sections: ['contexte', 'enjeux'], publicResearch: true, website: 'https://www.exemple-client.fr',
    }).expect(200);

    const research = calls.find((c) => c.method === 'research')!;
    expect(Object.keys(research.input).sort()).toEqual(['companyName', 'website']);
    const draft = calls.find((c) => c.method === 'draft')!;
    expect(JSON.stringify(draft.input)).not.toContain(customerName);
    expect(String(draft.input.research)).toContain('[CLIENT]');

    expect(r.body.pointsToVerify).toEqual(['Nombre de magasins à confirmer.']);
    const sections = r.body.proposal.version.sections;
    const contexte = sections.find((s: { key: string }) => s.key === 'contexte');
    expect(contexte).toMatchObject({ aiPendingReview: true, aiSources: [expect.objectContaining({ url: expect.stringContaining('annuaire') })] });
    expect(JSON.stringify(contexte.blocks)).toContain(customerName);
  });

  test('une section générée par IA bloque l’envoi, même réenregistrée, jusqu’à sa validation', async () => {
    const d = await http().get(`/v1/proposals/${id}`).set('x-lsi-session', AM).expect(200);
    const sections = d.body.version.sections.map((s: any) => ({
      key: s.key, title: s.title, kind: s.kind, optional: s.optional, excluded: s.excluded,
      libraryItemKey: s.libraryItemKey, guidance: s.guidance, blocks: s.blocks,
    }));
    await http().put(`/v1/proposals/${id}/sections`).set('x-lsi-session', AM).send({ sections }).expect(200);
    const before = await http().get(`/v1/proposals/${id}/readiness`).set('x-lsi-session', AM).expect(200);
    expect(before.body.issues.filter((i: { code: string }) => i.code === 'AI_PENDING').map((i: { sectionKey: string }) => i.sectionKey).sort()).toEqual(['contexte', 'enjeux']);

    await http().post(`/v1/proposals/${id}/sections/contexte/ai-validate`).set('x-lsi-session', 'pai-reader').expect(403);
    await http().post(`/v1/proposals/${id}/sections/contexte/ai-validate`).set('x-lsi-session', AM).expect(200);
    await http().post(`/v1/proposals/${id}/sections/enjeux/ai-validate`).set('x-lsi-session', AM).expect(200);
    await http().post(`/v1/proposals/${id}/sections/enjeux/ai-validate`).set('x-lsi-session', AM).expect(404);
    const after = await http().get(`/v1/proposals/${id}/readiness`).set('x-lsi-session', AM).expect(200);
    expect(after.body.issues.some((i: { code: string }) => i.code === 'AI_PENDING')).toBe(false);
  });

  test('sans recherche publique : aucun appel de recherche', async () => {
    await http().post(`/v1/proposals/${id}/ai/draft`).set('x-lsi-session', AM)
      .send({ notes: 'Client satisfait du support, souhaite une supervision 24/7.', sections: ['enjeux'] }).expect(200);
    expect(calls.map((c) => c.method)).toEqual(['draft']);
  });

  test('reformulation : suggestion seulement, valeurs réelles réinjectées', async () => {
    const r = await http().post(`/v1/proposals/${id}/ai/rephrase`).set('x-lsi-session', AM)
      .send({ text: `${customerName} souhaite externaliser son support.`, mode: 'reformuler' }).expect(200);
    expect(r.body.text).toContain(customerName);
    expect(JSON.stringify(calls[0]!.input)).not.toContain(customerName);
  });

  test('IA désactivée → 503, rien ne part', async () => {
    await flag('contrats.ai.enabled', false);
    try {
      await http().post(`/v1/proposals/${id}/ai/rephrase`).set('x-lsi-session', AM).send({ text: 'Bonjour', mode: 'synthetiser' }).expect(503);
      expect(calls).toHaveLength(0);
    } finally {
      await flag('contrats.ai.enabled', true);
    }
  });
});
