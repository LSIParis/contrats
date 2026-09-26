import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ProviderAuthError,
  ProviderError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderValidationError,
  signerRoleLabel,
  type CreateSubmissionCommand,
  type SubmitterCommand,
} from '@lsi/domain';
import { DocusealAdapter } from '../../src/signature/docuseal.adapter.js';
import {
  docusealSignature,
  fixtureFetchError,
  fixtureResponse,
  fixtureText,
  loadFixture,
  pdfResponse,
  stubFetch,
} from '../support/docuseal-fixtures.js';

/**
 * Adaptateur DocuSeal Pro contre des FIXTURES (fetch simulé, aucun réseau).
 *
 * Ce test vérifie que nous parlons le contrat d'API DOCUMENTÉ (vérifié le
 * 2026-09-26) — le test d'intégration `docuseal-ee.integration.test.ts`
 * vérifie, lui, que l'instance réelle l'accepte. Les deux sont nécessaires :
 * une fixture fausse donnerait un test vert et un code inutilisable (leçon
 * du HMAC, voir l'adaptateur).
 */

const BASE = 'https://signe.example.test/api';
const ENV_KEYS = [
  'DOCUSEAL_URL',
  'DOCUSEAL_API_KEY',
  'DOCUSEAL_TIMEOUT_MS',
  'DOCUSEAL_WEBHOOK_SECRET',
  'DOCUSEAL_WEBHOOK_HEADER_SECRET',
  'DOCUSEAL_WEBHOOK_HEADER_NAME',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DOCUSEAL_URL = `${BASE}/`; // barre finale : doit être tolérée
  process.env.DOCUSEAL_API_KEY = 'test-token';
  process.env.DOCUSEAL_WEBHOOK_SECRET = 'whsec';
  delete process.env.DOCUSEAL_WEBHOOK_HEADER_SECRET;
  delete process.env.DOCUSEAL_WEBHOOK_HEADER_NAME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const adapter = new DocusealAdapter();
const PDF = Buffer.from('%PDF-1.7\n{{Signature Client;role=Client;type=signature}}\n%%EOF', 'utf8');
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');

function signer(party: 'LSI' | 'CLIENT', signingOrder: number): SubmitterCommand {
  return {
    party,
    roleLabel: signerRoleLabel(party),
    externalId: party === 'LSI' ? 'signer-lsi' : 'signer-client',
    fullName: party === 'LSI' ? 'Marc D.' : 'J. Dupont',
    email: party === 'LSI' ? 'direction@lsi.example.test' : 'j.dupont@client.example.test',
    signingOrder,
    requireEmail2fa: party === 'CLIENT',
    fields: [],
  };
}

function cmd(over: Partial<CreateSubmissionCommand> = {}): CreateSubmissionCommand {
  return {
    pdf: PDF,
    pdfSha256: PDF_SHA,
    documentName: 'LSI-2026-0001.pdf',
    expireAt: new Date('2026-10-26T08:00:00Z'),
    subject: 'Contrat LSI-2026-0001',
    body: 'Veuillez signer : {{submitter.link}}',
    completedRedirectUrl: 'https://contrats.example.test/portal/signature-complete',
    submitters: [signer('LSI', 0), signer('CLIENT', 1)],
    metadata: { tenant_id: 't1', signature_request_id: 'sr1' },
    ...over,
  };
}

const CREATE = { method: 'POST', match: `${BASE}/submissions/pdf` } as const;

describe('POST /submissions/pdf — voie nominale', () => {
  test('payload conforme : jeton, PDF base64, rôles, ordre client puis LSI par défaut', async () => {
    const calls = stubFetch([{ ...CREATE, reply: () => fixtureResponse('create-submission-pdf.success.json') }]);

    const res = await adapter.createSubmission(cmd());

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.headers['x-auth-token']).toBe('test-token');
    const body = call.body as any;
    expect(body.documents[0]).toEqual({ name: 'LSI-2026-0001.pdf', file: PDF.toString('base64') });
    expect(body.send_email).toBe(true);
    expect(body.order).toBe('preserved');
    expect(body.expire_at).toBe('2026-10-26 08:00:00 UTC');
    expect(body.message).toEqual({ subject: 'Contrat LSI-2026-0001', body: 'Veuillez signer : {{submitter.link}}' });
    // Défaut du brief : le client signe d'abord, LSI contresigne.
    expect(body.submitters.map((s: any) => [s.role, s.order, s.external_id])).toEqual([
      ['Client', 0, 'signer-client'],
      ['LSI Maintenance', 1, 'signer-lsi'],
    ]);
    expect(body.submitters[0].require_email_2fa).toBe(true);
    expect(body.submitters[0].metadata).toEqual({ tenant_id: 't1', signature_request_id: 'sr1' });

    expect(res.providerSubmissionId).toBe('4242');
    expect(res.submitters[0]).toEqual({
      externalId: '__CLIENT_SIGNER_ID__',
      providerSubmitterId: '7001',
      slug: 'dsEeWrhRD8yDXT',
      embedSrc: 'https://signe.example.test/s/dsEeWrhRD8yDXT',
    });
  });

  test('appelant historique (order: preserved) : l’ordre saisi est respecté', async () => {
    const calls = stubFetch([{ ...CREATE, reply: () => fixtureResponse('create-submission-pdf.success.json') }]);
    await adapter.createSubmission(cmd({ order: 'preserved' }));
    expect((calls[0]!.body as any).submitters.map((s: any) => s.role)).toEqual(['LSI Maintenance', 'Client']);
  });

  test('politique explicite PARALLEL → order random', async () => {
    const calls = stubFetch([{ ...CREATE, reply: () => fixtureResponse('create-submission-pdf.success.json') }]);
    await adapter.createSubmission(cmd({ signingOrder: 'PARALLEL' }));
    expect((calls[0]!.body as any).order).toBe('random');
  });

  test('signature intégrée (EMBEDDED) : aucun e-mail DocuSeal, même si sendEmail est vrai', async () => {
    const calls = stubFetch([{ ...CREATE, reply: () => fixtureResponse('create-submission-pdf.success.json') }]);
    await adapter.createSubmission(cmd({ delivery: 'EMBEDDED', sendEmail: true }));
    expect((calls[0]!.body as any).send_email).toBe(false);
  });

  test('PDF ≠ empreinte stockée : refus AVANT tout envoi', async () => {
    const calls = stubFetch([]);
    await expect(adapter.createSubmission(cmd({ pdfSha256: 'f'.repeat(64) }))).rejects.toMatchObject({
      code: 'VALIDATION',
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  test('401 → ProviderAuthError (jeton invalide, non réessayable)', async () => {
    stubFetch([{ ...CREATE, reply: () => fixtureResponse('create-submission-pdf.401.json') }]);
    const err = await adapter.createSubmission(cmd()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBe(401);
  });

  test('422 → ProviderValidationError avec le message DocuSeal', async () => {
    stubFetch([{ ...CREATE, reply: () => fixtureResponse('create-submission-pdf.422.json') }]);
    const err = await adapter.createSubmission(cmd()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderValidationError);
    expect(err.providerMessage).toBe('Unknown field: Montant');
    expect(err.retryable).toBe(false);
  });

  test('500 → ProviderUnavailableError (réessayable)', async () => {
    stubFetch([{ ...CREATE, reply: () => fixtureResponse('create-submission-pdf.500.json') }]);
    const err = await adapter.createSubmission(cmd()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect(err.retryable).toBe(true);
  });

  test('délai dépassé → ProviderTimeoutError (réessayable APRÈS vérification)', async () => {
    stubFetch([{ ...CREATE, reply: () => Promise.reject(fixtureFetchError('create-submission-pdf.timeout.json')) }]);
    const err = await adapter.createSubmission(cmd()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect(err.code).toBe('TIMEOUT');
  });

  test('réseau coupé → ProviderUnavailableError', async () => {
    stubFetch([{ ...CREATE, reply: () => Promise.reject(new TypeError('fetch failed')) }]);
    await expect(adapter.createSubmission(cmd())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  test('jeton absent → ProviderAuthError sans appel réseau', async () => {
    delete process.env.DOCUSEAL_API_KEY;
    const calls = stubFetch([]);
    await expect(adapter.createSubmission(cmd())).rejects.toBeInstanceOf(ProviderAuthError);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /submissions — voie secondaire (modèle figé)', () => {
  test('template_id numérique, réponse TABLEAU de submitters', async () => {
    const calls = stubFetch([
      { method: 'POST', match: `${BASE}/submissions`, reply: () => fixtureResponse('create-submission-template.success.json') },
    ]);
    const { pdf: _pdf, pdfSha256: _sha, documentName: _name, ...rest } = cmd();
    const res = await adapter.createSubmissionFromTemplate({ ...rest, providerTemplateId: '12' });

    const body = calls[0]!.body as any;
    expect(body.template_id).toBe(12);
    expect(body.documents).toBeUndefined();
    expect(res.providerSubmissionId).toBe('4343');
    expect(res.submitters).toHaveLength(2);
  });

  test('identifiant de modèle non numérique : refus local', async () => {
    const calls = stubFetch([]);
    const { pdf: _pdf, pdfSha256: _sha, documentName: _name, ...rest } = cmd();
    await expect(adapter.createSubmissionFromTemplate({ ...rest, providerTemplateId: 'abc' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('lecture', () => {
  const vars = { SUBMISSION_ID: 4242, CLIENT_SIGNER_ID: 'signer-client', LSI_SIGNER_ID: 'signer-lsi' };

  test('findSubmissionByExternalId passe par GET /submitters?external_id= (seul filtre documenté)', async () => {
    const calls = stubFetch([
      { match: `${BASE}/submitters?external_id=signer-client&limit=1`, reply: () => fixtureResponse('submitters.by-external-id.json', vars) },
      { match: `${BASE}/submissions/4242`, reply: () => fixtureResponse('get-submission.pending.json', vars) },
    ]);
    const found = await adapter.findSubmissionByExternalId('signer-client');
    expect(found?.providerSubmissionId).toBe('4242');
    expect(found?.submitters.map((s) => s.externalId)).toEqual(['signer-client', 'signer-lsi']);
    expect(calls.some((c) => c.url.includes('/submissions?external_id'))).toBe(false);
  });

  test('findSubmissionByExternalId : aucun signataire → null', async () => {
    stubFetch([{ match: /\/submitters\?external_id=/, reply: () => fixtureResponse('submitters.empty.json') }]);
    expect(await adapter.findSubmissionByExternalId('inconnu')).toBeNull();
  });

  test('findSubmissionByExternalId : une panne LÈVE (« je ne sais pas » ≠ « absente »)', async () => {
    stubFetch([{ match: /\/submitters\?external_id=/, reply: () => fixtureResponse('create-submission-pdf.500.json') }]);
    await expect(adapter.findSubmissionByExternalId('x')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  test('getSubmission normalise les statuts', async () => {
    stubFetch([{ match: `${BASE}/submissions/4242`, reply: () => fixtureResponse('get-submission.pending.json', vars) }]);
    const s = await adapter.getSubmission('4242');
    expect(s.status).toBe('PENDING');
    expect(s.submitters.map((x) => [x.externalId, x.status])).toEqual([
      ['signer-client', 'COMPLETED'],
      ['signer-lsi', 'SENT'],
    ]);
    expect(s.submitters[0]!.completedAt).toEqual(new Date('2026-09-27T09:10:00.000Z'));
  });

  test('getSubmission : 404 → NOT_FOUND non réessayable', async () => {
    stubFetch([{ match: `${BASE}/submissions/9`, reply: () => fixtureResponse('get-submission.404.json') }]);
    await expect(adapter.getSubmission('9')).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });
});

describe('downloadCompletedDocuments — copie locale des preuves', () => {
  const vars = { SUBMISSION_ID: 4242, CLIENT_SIGNER_ID: 'c', LSI_SIGNER_ID: 'l' };
  const FILES = /^https:\/\/signe\.example\.test\/file\//;

  test('fusionné (merge=true) + documents + journal d’audit + combiné, SANS jeton vers les fichiers', async () => {
    const calls = stubFetch([
      { match: `${BASE}/submissions/4242`, reply: () => fixtureResponse('get-submission.completed.json', vars) },
      { match: `${BASE}/submissions/4242/documents?merge=true`, reply: () => fixtureResponse('submission-documents.merge.json', vars) },
      { match: FILES, reply: () => pdfResponse('fichier') },
    ]);

    const docs = await adapter.downloadCompletedDocuments('4242');

    expect(docs.mergedPdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(docs.auditLogPdf).not.toBeNull();
    expect(docs.combinedPdf).not.toBeNull();
    expect(docs.documents.map((d) => d.name)).toEqual(['LSI-2026-0001']);

    const fileCalls = calls.filter((c) => FILES.test(c.url));
    expect(fileCalls.map((c) => c.url)).toEqual([
      'https://signe.example.test/file/merged-hash/LSI-2026-0001.pdf',
      'https://signe.example.test/file/doc-hash/LSI-2026-0001.pdf',
      'https://signe.example.test/file/audit-hash/audit-log.pdf',
      'https://signe.example.test/file/combined-hash/combined.pdf',
    ]);
    // Le jeton d'API ne part JAMAIS vers une URL reçue du réseau.
    expect(fileCalls.every((c) => c.headers['x-auth-token'] === undefined)).toBe(true);
  });

  test('submission non complétée → NOT_READY (réessayable plus tard)', async () => {
    stubFetch([{ match: `${BASE}/submissions/4242`, reply: () => fixtureResponse('get-submission.pending.json', vars) }]);
    await expect(adapter.downloadCompletedDocuments('4242')).rejects.toMatchObject({ code: 'NOT_READY', retryable: true });
  });

  test('un fichier qui n’est pas un PDF est refusé (page d’erreur ≠ preuve)', async () => {
    stubFetch([
      { match: `${BASE}/submissions/4242`, reply: () => fixtureResponse('get-submission.completed.json', vars) },
      { match: `${BASE}/submissions/4242/documents?merge=true`, reply: () => fixtureResponse('submission-documents.merge.json', vars) },
      { match: FILES, reply: () => new Response('<html>502</html>', { status: 200 }) },
    ]);
    const err = await adapter.downloadCompletedDocuments('4242').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('PROTOCOL');
  });

  test('downloadSignedDocuments (historique) délègue : PDF fusionné + audit', async () => {
    stubFetch([
      { match: `${BASE}/submissions/4242`, reply: () => fixtureResponse('get-submission.completed.json', vars) },
      { match: `${BASE}/submissions/4242/documents?merge=true`, reply: () => fixtureResponse('submission-documents.merge.json', vars) },
      { match: FILES, reply: () => pdfResponse('fichier') },
    ]);
    const d = await adapter.downloadSignedDocuments('4242');
    expect(d.signedPdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(d.auditTrail).not.toBeNull();
  });
});

describe('checkReadiness — sonde /readyz', () => {
  const PROBE = `${BASE}/templates?limit=1`;

  test('joignable et jeton valide', async () => {
    stubFetch([{ match: PROBE, reply: () => fixtureResponse('templates.list.json') }]);
    expect(await adapter.checkReadiness()).toEqual({ reachable: true, tokenValid: true, detail: 'ok' });
  });

  test('401 : joignable, jeton refusé', async () => {
    stubFetch([{ match: PROBE, reply: () => fixtureResponse('create-submission-pdf.401.json') }]);
    expect(await adapter.checkReadiness()).toMatchObject({ reachable: true, tokenValid: false });
  });

  test('délai dépassé : injoignable — et la sonde ne lève jamais', async () => {
    stubFetch([{ match: PROBE, reply: () => Promise.reject(fixtureFetchError('create-submission-pdf.timeout.json')) }]);
    expect(await adapter.checkReadiness()).toMatchObject({ reachable: false, tokenValid: false });
  });

  test('jeton non configuré : aucun appel réseau', async () => {
    delete process.env.DOCUSEAL_API_KEY;
    const calls = stubFetch([]);
    expect(await adapter.checkReadiness()).toMatchObject({ reachable: false, tokenValid: false });
    expect(calls).toHaveLength(0);
  });
});

describe('webhooks — authentification et normalisation', () => {
  const vars = {
    SUBMISSION_ID: 4242,
    CLIENT_SIGNER_ID: 'signer-client',
    LSI_SIGNER_ID: 'signer-lsi',
    TENANT_ID: 't1',
    CUSTOMER_ID: 'c1',
    CONTRACT_ID: 'k1',
    SIGNATURE_REQUEST_ID: 'sr1',
  };

  test('HMAC valide sans secret partagé configuré → accepté', () => {
    const body = fixtureText('webhook.form-viewed.json', vars);
    const v = adapter.verifyWebhook(Buffer.from(body), { 'x-docuseal-signature': docusealSignature('whsec', body) });
    expect(v.valid).toBe(true);
  });

  test('secret partagé configuré : absent, faux, puis correct', () => {
    process.env.DOCUSEAL_WEBHOOK_HEADER_SECRET = 'partage-123';
    const body = fixtureText('webhook.form-viewed.json', vars);
    const sig = docusealSignature('whsec', body);

    expect(adapter.verifyWebhook(Buffer.from(body), { 'x-docuseal-signature': sig })).toEqual({
      valid: false,
      reason: 'secret partagé absent',
    });
    expect(
      adapter.verifyWebhook(Buffer.from(body), { 'x-docuseal-signature': sig, 'x-docuseal-webhook-secret': 'faux' }).valid,
    ).toBe(false);
    expect(
      adapter.verifyWebhook(Buffer.from(body), { 'x-docuseal-signature': sig, 'x-docuseal-webhook-secret': 'partage-123' })
        .valid,
    ).toBe(true);
  });

  test('nom d’en-tête du secret partagé configurable', () => {
    process.env.DOCUSEAL_WEBHOOK_HEADER_SECRET = 'partage-123';
    process.env.DOCUSEAL_WEBHOOK_HEADER_NAME = 'X-LSI-Secret';
    const body = fixtureText('webhook.form-viewed.json', vars);
    const v = adapter.verifyWebhook(Buffer.from(body), {
      'x-docuseal-signature': docusealSignature('whsec', body),
      'x-lsi-secret': 'partage-123',
    });
    expect(v.valid).toBe(true);
  });

  test('le secret partagé NE REMPLACE PAS le HMAC', () => {
    process.env.DOCUSEAL_WEBHOOK_HEADER_SECRET = 'partage-123';
    const body = fixtureText('webhook.form-viewed.json', vars);
    const v = adapter.verifyWebhook(Buffer.from(body), { 'x-docuseal-webhook-secret': 'partage-123' });
    expect(v).toEqual({ valid: false, reason: 'signature absente' });
  });

  test.each([
    ['webhook.form-viewed.json', 'FORM_VIEWED', '7001', 'signer-client'],
    ['webhook.form-started.json', 'FORM_STARTED', '7001', 'signer-client'],
    ['webhook.form-completed.client.json', 'FORM_COMPLETED', '7001', 'signer-client'],
    ['webhook.form-completed.lsi.json', 'FORM_COMPLETED', '7002', 'signer-lsi'],
    ['webhook.form-declined.json', 'FORM_DECLINED', '7001', 'signer-client'],
    ['webhook.submission-completed.json', 'SUBMISSION_COMPLETED', '', null],
    ['webhook.submission-expired.json', 'SUBMISSION_EXPIRED', '', null],
  ])('%s → %s', (file, kind, submitterId, externalId) => {
    const ev = adapter.parseWebhook(loadFixture(file, vars));
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe(kind);
    expect(ev!.providerSubmissionId).toBe('4242');
    expect(ev!.providerSubmitterId).toBe(submitterId);
    expect(ev!.externalSignerId).toBe(externalId);
  });

  test('form.declined porte le motif', () => {
    const ev = adapter.parseWebhook(loadFixture('webhook.form-declined.json', vars));
    expect(ev!.declineReason).toContain('annexe 2');
  });

  test('un rejeu produit le MÊME eventId (support de l’idempotence)', () => {
    const seq = loadFixture<{ deliveries: unknown[] }>('webhook-sequence.replayed.json', vars);
    const [a, b] = seq.deliveries.map((d) => adapter.parseWebhook(d)!.eventId);
    expect(a).toBe(b);
  });

  test('événement non géré → null', () => {
    expect(adapter.parseWebhook({ event_type: 'template.created', data: { id: 1 } })).toBeNull();
  });
});
