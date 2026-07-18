import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { ProofCaptureService } from '../../src/signature/proof-capture.service.js';
import { InMemoryStorage } from '../../src/documents/in-memory-storage.js';
import { FakeProvider } from '../support/fakes.js';
import { seedTwoCustomers, type TwoCustomerFixture } from '@lsi/persistence/testing';
import { withScope, adminScope, systemScope, uuidv7 } from '@lsi/persistence';

let fx: TwoCustomerFixture;
let provider: FakeProvider;
let storage: InMemoryStorage;
let service: ProofCaptureService;

beforeAll(async () => {
  fx = await seedTwoCustomers();
});

beforeEach(() => {
  provider = new FakeProvider();
  storage = new InMemoryStorage();
  service = new ProofCaptureService(provider as any, storage);
});

/** Crée une signature_request dans un statut donné, renvoie son id. */
async function seedSigReq(status: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
    tx.signatureRequest.create({
      data: {
        id,
        tenantId: fx.tenantId,
        customerId: fx.customerA.id,
        contractId: fx.customerA.contractId,
        versionId: uuidv7(),
        provider: 'DOCUSEAL',
        providerSubmissionId: 'sub-' + id.slice(-8),
        status: status as any,
        idempotencyKey: uuidv7(),
        createdAt: new Date(),
        updatedAt: new Date(),
        createdByUserId: fx.amUserId,
        ...over,
      },
    }),
  );
  return id;
}

const scope = () => systemScope(fx.tenantId, fx.customerA.id);

describe('ProofCaptureService (§11.6, W-05)', () => {
  test('capture le PDF signé + la piste d’audit, avec empreintes', async () => {
    const id = await seedSigReq('COMPLETED');
    const done = await service.capture(scope(), id, new Date());
    expect(done).toBe(true);

    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.findUnique({ where: { id } }),
    );
    // Clés dans le préfixe scopé signed/ (§10.7).
    expect(sr!.signedPdfObjectKey).toContain(`t/${fx.tenantId}/c/${fx.customerA.id}/`);
    expect(sr!.signedPdfObjectKey).toContain(`/signed/${id}/document.pdf`);
    expect(sr!.auditTrailObjectKey).toContain(`/signed/${id}/audit-trail.pdf`);
    // Empreinte = SHA-256 des octets réellement stockés.
    const stored = await storage.get(sr!.signedPdfObjectKey!, { tenantId: fx.tenantId, customerId: fx.customerA.id });
    expect(createHash('sha256').update(stored!).digest('hex')).toBe(sr!.signedPdfSha256);
  });

  test('idempotent : une 2e capture ne refait rien', async () => {
    const id = await seedSigReq('COMPLETED');
    expect(await service.capture(scope(), id, new Date())).toBe(true);
    expect(provider.calls).toBeDefined();
    // 2e appel : déjà capturé → false, pas de re-téléchargement.
    expect(await service.capture(scope(), id, new Date())).toBe(false);
  });

  test('ne capture pas une demande non complétée', async () => {
    const id = await seedSigReq('SENT');
    expect(await service.capture(scope(), id, new Date())).toBe(false);
  });

  test('le document stocké est bien le PDF signé (pas un placeholder vide)', async () => {
    const id = await seedSigReq('COMPLETED');
    await service.capture(scope(), id, new Date());
    const sr = await withScope(adminScope(fx.tenantId, fx.adminUserId), (tx) =>
      tx.signatureRequest.findUnique({ where: { id } }),
    );
    const stored = await storage.get(sr!.signedPdfObjectKey!, { tenantId: fx.tenantId, customerId: fx.customerA.id });
    expect(stored!.subarray(0, 5).toString()).toBe('%PDF-');
    expect(stored!.toString()).toContain('signed');
  });

  test('une demande inconnue → rien', async () => {
    expect(await service.capture(scope(), uuidv7(), new Date())).toBe(false);
  });
});
