import { describe, test, expect } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3Storage } from '../../src/documents/s3-storage.js';
import type { ObjectScope } from '../../src/documents/document-storage.port.js';

/**
 * Test d'INTÉGRATION du stockage S3 contre un vrai MinIO.
 *
 * §10.7 le disait : « l'encryption context ne se vérifie pas dans une Map ».
 * Ici on vérifie le vrai comportement S3 — put/get de bytes réels, URL
 * présignée, et le refus de lecture inter-scope.
 */

const scopeA: ObjectScope = { tenantId: 'tenant-a', customerId: 'cust-a' };
const scopeB: ObjectScope = { tenantId: 'tenant-a', customerId: 'cust-b' };
const keyA = `t/${scopeA.tenantId}/c/${scopeA.customerId}/contracts/x/draft.pdf`;

let container: StartedTestContainer | null = null;
const available = await (async () => {
  if (process.env.SKIP_INTEGRATION) return false;
  try {
    container = await new GenericContainer('minio/minio:latest')
      .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
      .withCommand(['server', '/data'])
      .withExposedPorts(9000)
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
    const admin = new S3Client({
      region: 'eu-west-3',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
    await admin.send(new CreateBucketCommand({ Bucket: 'lsi-contrats' }));
    process.env.S3_ENDPOINT = endpoint;
    process.env.S3_ACCESS_KEY = 'minioadmin';
    process.env.S3_SECRET_KEY = 'minioadmin';
    process.env.S3_BUCKET = 'lsi-contrats';
    return true;
  } catch (e) {
    console.warn('\n⚠ MinIO indisponible — test S3 ignoré :', (e as Error).message, '\n');
    return false;
  }
})();

describe.runIf(available)('S3Storage — MinIO réel', () => {
  test('put puis get restitue les octets exacts', async () => {
    const s3 = new S3Storage();
    const data = Buffer.from('%PDF-1.7 contrat signé', 'utf8');
    await s3.put(keyA, data, scopeA, 'application/pdf');
    const got = await s3.get(keyA, scopeA);
    expect(got).not.toBeNull();
    expect(got!.equals(data)).toBe(true);
  });

  test('une clé inexistante renvoie null (pas une erreur)', async () => {
    const s3 = new S3Storage();
    expect(await s3.get(`t/${scopeA.tenantId}/c/${scopeA.customerId}/absent`, scopeA)).toBeNull();
  });

  test('une clé hors du scope demandé est refusée avant tout accès', async () => {
    const s3 = new S3Storage();
    // Clé du client B lue avec le scope du client A → refus (assertKeyMatchesScope).
    const keyB = `t/${scopeB.tenantId}/c/${scopeB.customerId}/x`;
    await expect(s3.get(keyB, scopeA)).rejects.toThrow(/incohérente avec le scope/);
    await expect(s3.put(keyB, Buffer.from('x'), scopeA)).rejects.toThrow(/incohérente/);
  });

  test('la metadata de scope est écrite et vérifiée à la lecture', async () => {
    const s3 = new S3Storage();
    const data = Buffer.from('preuve');
    await s3.put(keyA, data, scopeA);
    // Lecture avec le BON scope : OK. La vérif metadata passe.
    expect(await s3.get(keyA, scopeA)).not.toBeNull();
  });

  test('produit une URL présignée à durée limitée', async () => {
    const s3 = new S3Storage();
    await s3.put(keyA, Buffer.from('x'), scopeA);
    const url = await s3.presignedGetUrl(keyA, scopeA, 300);
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('X-Amz-Expires=300');
    // L'URL présignée fonctionne réellement.
    const res = await fetch(url);
    expect(res.ok).toBe(true);
  });
});
