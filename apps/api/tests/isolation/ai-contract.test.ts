import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { createTestApp } from '../support/app.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SessionService } from '../../src/auth/session.service.js';
import { DRAFTING_REGISTRY } from '../../src/ai-drafting/ai-gateway.service.js';
import { DraftingProviderRegistry } from '../../src/ai-drafting/drafting-provider-registry.js';
import { AiTimeoutError } from '../../src/ai-drafting/drafting-errors.js';
import type { AiCallResult, ContractDraftingProvider } from '../../src/ai-drafting/contract-drafting-provider.port.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from '../../src/documents/document-storage.port.js';
import { adminScope, clientScope, internalScope, withScope, uuidv7 } from '@lsi/persistence';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';

/**
 * Lot 6 — assistance IA : drapeau, pseudonymisation effective, budget,
 * journal d'usage, clauses « à revoir », extraction assistée d'un import.
 */
const sent: string[] = [];
let failNext: Error | null = null;

function env<T>(data: T, cost = 0.02): AiCallResult<T> {
  return { data, sources: [{ url: 'https://www.legifrance.gouv.fr/x', title: 'Code civil', origin: 'search_result' }], usage: { inputTokens: 100, outputTokens: 50, costUsd: cost }, provider: 'perplexity', model: 'fake', warnings: [], raw: { request: null, response: null } };
}

class FakeProvider implements ContractDraftingProvider {
  readonly name = 'perplexity' as const;
  private track(x: unknown) {
    // `knownEntities` ne sert qu’au garde-fou local (assertNoLeak) : il ne part jamais.
    const { knownEntities: _k, ...outbound } = x as Record<string, unknown>;
    sent.push(JSON.stringify(outbound));
    if (failNext) { const e = failNext; failNext = null; throw e; }
  }
  async draftStructured(i: Parameters<ContractDraftingProvider['draftStructured']>[0]) {
    this.track(i);
    const clauses = [
      { title: 'Objet', text: 'Le Prestataire fournit à [CLIENT] les services décrits.', category: 'OBJET' as const, riskLevel: 'LOW' as const, justification: 'Article 1103 du Code civil.', removedUrls: [] },
      { title: 'Responsabilité', text: 'Plafond : montant annuel.', category: 'RESPONSABILITE' as const, riskLevel: 'HIGH' as const, justification: 'À vérifier.', removedUrls: [] },
    ];
    return { ...env({ clauses, suggestedAnnexes: [] }), clauses, suggestedAnnexes: [] };
  }
  async rephraseClause(i: Parameters<ContractDraftingProvider['rephraseClause']>[0]) {
    this.track(i);
    return env({ clause: { title: i.clause.title, text: `Version claire pour [CLIENT].`, category: 'OBJET' as const, riskLevel: 'LOW' as const, justification: 'ok', removedUrls: [] }, changes: ['simplifiée'] });
  }
  async explainClause(i: Parameters<ContractDraftingProvider['explainClause']>[0]) {
    this.track(i);
    return env({ summary: 'Explication.', keyPoints: [], pointsOfAttention: [] });
  }
  async compareClause(i: Parameters<ContractDraftingProvider['compareClause']>[0]) {
    this.track(i);
    return env({ closestItemId: '', similarity: 'UNRELATED' as const, differences: [], recommendation: 'r' } as never);
  }
  async detectMissingClauses(i: Parameters<ContractDraftingProvider['detectMissingClauses']>[0]) {
    this.track(i);
    return env({ missing: [{ title: 'Réversibilité', category: 'REVERSIBILITE', reason: 'Absente', riskLevel: 'MEDIUM' }] } as never);
  }
  async extractImportMetadata(i: Parameters<ContractDraftingProvider['extractImportMetadata']>[0]) {
    this.track(i);
    const none = { value: '', excerpt: '' };
    return env({
      dateSignature: none, dateEffet: none,
      dureeMois: { value: '36', excerpt: 'pour une durée de trente-six mois' },
      reconduction: { value: 'TACITE', excerpt: 'inventé, absent du document' },
      preavis: none, montantMensuelHt: none, montantAnnuelHt: none, indiceRevision: none,
    });
  }
}

let app: INestApplication;
let fx: TwoCustomerFixture;
let customerName: string;
let contractId: string;
const admin = () => adminScope(fx.tenantId, fx.adminUserId);
const http = () => request(app.getHttpServer());

async function setFlag(enabled: boolean) {
  await withScope(admin(), (tx) => tx.tenantFeatureFlag.upsert({
    where: { tenantId_key: { tenantId: fx.tenantId, key: 'contrats.ai.enabled' } },
    create: { tenantId: fx.tenantId, key: 'contrats.ai.enabled', enabled, updatedAt: new Date() },
    update: { enabled },
  }));
}
async function setBudget(v: number | null) {
  if (v === null) {
    await withScope(admin(), (tx) => tx.tenantSetting.deleteMany({ where: { key: 'ai.monthlyBudgetUsd' } }));
    return;
  }
  await withScope(admin(), (tx) => tx.tenantSetting.upsert({
    where: { tenantId_key: { tenantId: fx.tenantId, key: 'ai.monthlyBudgetUsd' } },
    create: { tenantId: fx.tenantId, key: 'ai.monthlyBudgetUsd', value: v as never, updatedAt: new Date() },
    update: { value: v as never },
  }));
}

beforeAll(async () => {
  const registry = new DraftingProviderRegistry({ PERPLEXITY_API_KEY: 'test' }, { perplexity: () => new FakeProvider() });
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRAFTING_REGISTRY).useValue(registry).compile();
  app = await createTestApp(mod);
  fx = await seedTwoCustomers();
  contractId = uuidv7();
  const now = new Date();
  await withScope(admin(), async (tx) => {
    customerName = (await tx.customer.findUnique({ where: { id: fx.customerA.id } }))!.name;
    await tx.contract.create({ data: {
      id: contractId, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `IA-${contractId.slice(-12)}`, title: 'Infogérance',
      type: 'MAIN', status: 'DRAFT', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
      ownerUserId: fx.amUserId, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
    } });
  });
  const s = app.get(SessionService);
  await s.put({ sessionId: 'ai-am', userId: fx.amUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerA.id], fx.amUserId) });
  await s.put({ sessionId: 'ai-am-b', userId: fx.amBUserId, tenantId: fx.tenantId, roles: ['ACCOUNT_MANAGER'], scope: internalScope(fx.tenantId, [fx.customerB.id], fx.amBUserId) });
  await s.put({ sessionId: 'ai-admin', userId: fx.adminUserId, tenantId: fx.tenantId, roles: ['MSP_ADMIN'], scope: admin() });
  await s.put({ sessionId: 'ai-client', userId: fx.customerA.clientUserId, tenantId: fx.tenantId, roles: ['CLIENT_SIGNER'], scope: clientScope(fx.tenantId, fx.customerA.id, fx.customerA.clientUserId) });
});
beforeEach(async () => { sent.length = 0; failNext = null; await setFlag(true); await setBudget(null); });

const draft = (sess = 'ai-am', id = contractId) =>
  http().post(`/v1/contracts/${id}/ai/draft`).set('x-lsi-session', sess)
    .send({ needs: `Infogérance du parc de ${'X'} pour le client, 40 postes`, services: ['Supervision'] });

describe('assistance IA sur un contrat', () => {
  test('drapeau coupé → 503 AI_DISABLED, rien ne part', async () => {
    await setFlag(false);
    const r = await draft().expect(503);
    expect(r.body.code).toBe('AI_DISABLED');
    expect(sent).toHaveLength(0);
  });

  test('rédaction : clauses IA à revoir, texte pseudonymisé à l’envoi, valeurs réelles réinjectées, usage journalisé', async () => {
    await http().post(`/v1/contracts/${contractId}/ai/draft`).set('x-lsi-session', 'ai-am')
      .send({ needs: `Infogérance pour ${customerName}, 40 postes`, services: [] }).expect(201);
    expect(sent.join('\n')).not.toContain(customerName);
    const [c, v, usage] = await withScope(admin(), async (tx) => {
      const c = await tx.contract.findUnique({ where: { id: contractId } });
      return [c, await tx.contractVersion.findUnique({ where: { id: c!.currentVersionId! }, include: { clauses: true } }),
        await tx.aiUsage.findMany({ where: { contractId } })] as const;
    });
    expect(c!.origin).toBe('AI');
    expect(c!.unreviewedAiClauses).toBeGreaterThan(0);
    expect(v!.clauses.every((cl) => cl.origin === 'AI')).toBe(true);
    expect(v!.clauses.find((cl) => cl.title === 'Objet')!.bodyHtml).toContain(customerName);
    expect(v!.clauses.find((cl) => cl.title === 'Responsabilité')!.aiRisk).toBe('HIGH');
    expect(usage.at(-1)).toMatchObject({ operation: 'DRAFT', provider: 'perplexity', status: 'OK', inputTokens: 100 });
  });

  test('suggestion sur une clause : jamais appliquée, valeurs réelles réinjectées', async () => {
    const st = await http().get(`/v1/contracts/${contractId}/structure`).set('x-lsi-session', 'ai-am').expect(200);
    const key = st.body.clauses[0].clauseKey;
    const before = st.body.versionId;
    const r = await http().post(`/v1/contracts/${contractId}/clauses/${key}/ai`).set('x-lsi-session', 'ai-am').send({ action: 'rephrase' }).expect(201);
    expect(r.body.suggestion.bodyHtml).toContain(customerName);
    const after = await http().get(`/v1/contracts/${contractId}/structure`).set('x-lsi-session', 'ai-am').expect(200);
    expect(after.body.versionId).toBe(before);
    await http().post(`/v1/contracts/${contractId}/ai/missing-clauses`).set('x-lsi-session', 'ai-am').expect(201);
  });

  test('budget mensuel atteint → 429 AI_BUDGET_EXCEEDED, aucun appel', async () => {
    await setBudget(0.001);
    const r = await draft().expect(429);
    expect(r.body.code).toBe('AI_BUDGET_EXCEEDED');
    expect(sent).toHaveLength(0);
  });

  test('défaillance du fournisseur → 504, aucun brouillon, échec journalisé', async () => {
    const st = await http().get(`/v1/contracts/${contractId}/structure`).set('x-lsi-session', 'ai-am').expect(200);
    failNext = new AiTimeoutError('lent', 'perplexity');
    await draft().expect(504);
    const after = await http().get(`/v1/contracts/${contractId}/structure`).set('x-lsi-session', 'ai-am').expect(200);
    expect(after.body.versionId).toBe(st.body.versionId);
    const last = await withScope(admin(), (tx) => tx.aiUsage.findFirst({ where: { contractId }, orderBy: { createdAt: 'desc' } }));
    expect(last!.status).toBe('TIMEOUT');
  });

  test('isolation et droits : hors portefeuille 404, client 403, usage réservé à l’admin', async () => {
    await draft('ai-am-b').expect(404);
    await draft('ai-client').expect(403);
    await http().get('/v1/admin/ai/usage').set('x-lsi-session', 'ai-am').expect(403);
    const u = await http().get('/v1/admin/ai/usage').set('x-lsi-session', 'ai-admin').expect(200);
    expect(u.body.totalCalls).toBeGreaterThan(0);
    const a = await http().get('/v1/ai/availability').set('x-lsi-session', 'ai-am').expect(200);
    expect(a.body).toMatchObject({ enabled: true, provider: 'perplexity', configured: true, available: true });
  });
});

describe('extraction assistée d’un import', () => {
  test('complète les champs manquants, écarte une valeur dont l’extrait est introuvable', async () => {
    const id = uuidv7();
    const docId = uuidv7();
    const txtId = uuidv7();
    const now = new Date();
    const text = `Contrat de maintenance entre LSI et ${customerName}. Il est conclu pour une durée de trente-six mois.`;
    const key = `t/${fx.tenantId}/c/${fx.customerA.id}/imports/${id}/ocr-1.txt`;
    await app.get<DocumentStorage>(DOCUMENT_STORAGE).put(key, Buffer.from(text), { tenantId: fx.tenantId, customerId: fx.customerA.id }, 'text/plain');
    await withScope(admin(), async (tx) => {
      await tx.contract.create({ data: {
        id, tenantId: fx.tenantId, customerId: fx.customerA.id, reference: `IMP-${id.slice(-12)}`, title: 'Importé',
        type: 'MAIN', status: 'IMPORTED_PENDING_VALIDATION', origin: 'IMPORTED', category: 'MAINTENANCE', currency: 'EUR', billingFrequency: 'MONTHLY',
        ownerUserId: fx.amUserId, createdAt: now, updatedAt: now, createdByUserId: fx.amUserId, updatedByUserId: fx.amUserId,
      } });
      for (const [did, kind, k] of [[docId, 'LEGACY_SCAN', `${key}.pdf`], [txtId, 'OCR_TEXT', key]] as const) {
        await tx.storedDocument.create({ data: { id: did, tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, kind, origin: 'UPLOAD', objectKey: k, filename: 'x', contentType: 'text/plain', sizeBytes: 1n, sha256: '0'.repeat(64), createdAt: now } });
      }
      await tx.contractImport.create({ data: {
        id: uuidv7(), tenantId: fx.tenantId, customerId: fx.customerA.id, contractId: id, originalDocumentId: docId, ocrTextDocumentId: txtId,
        ocrStatus: 'DONE', extraction: { dateEffet: { value: '2024-01-01', confidence: 1, evidence: null, method: 'SAISIE' } } as never,
        extractionMethod: 'RULES', createdByUserId: fx.amUserId, createdAt: now, updatedAt: now,
      } });
    });
    const r = await http().post(`/v1/contracts/${id}/import/ai-extract`).set('x-lsi-session', 'ai-am').expect(201);
    expect(sent.join('\n')).not.toContain(customerName);
    expect(r.body.added).toEqual(['dureeMois']);
    expect(r.body.extraction.dureeMois).toMatchObject({ value: 36, method: 'LLM' });
    expect(r.body.extraction.reconduction ?? null).toBeNull();
    expect(r.body.extraction.dateEffet.method).toBe('SAISIE');
    const imp = await withScope(admin(), (tx) => tx.contractImport.findFirst({ where: { contractId: id } }));
    expect(imp!.extractionMethod).toBe('RULES+LLM');
  });
});
