import { describe, test, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  computeSignature, signatureHeader, verifyWebhookSignature, generateWebhookSecret,
} from '../../src/webhooks-out/signature.js';
import { decryptSecret, encryptSecret, keyRingFromEnv } from '../../src/webhooks-out/secret-box.js';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, nextAttemptAfterFailure, disableAfterDead } from '../../src/webhooks-out/backoff.js';
import { isPrivateAddress, validateWebhookUrl, UnsafeWebhookTargetError } from '../../src/webhooks-out/ssrf.js';
import { postWebhook } from '../../src/webhooks-out/http-sender.js';
import {
  buildContractEventData, ContractEventDataSchema, WEBHOOK_EVENT_TYPES, WEBHOOK_EVENT_SCHEMAS,
} from '../../src/webhooks-out/events.js';

/**
 * Briques des webhooks sortants, sans base ni réseau externe : signature
 * (vecteurs connus calculés indépendamment avec `openssl dgst -sha256 -hmac`),
 * chiffrement du secret, échéancier de reprise, garde SSRF (adresse privée
 * refusée, redirection non suivie — serveur local 127.0.0.1).
 */

describe('signature HMAC-SHA256 « v1 »', () => {
  const body = '{"id":"0192a000-0000-7000-8000-000000000001","type":"ping"}';

  test('vecteurs connus (openssl) : message = "<timestamp>.<corps brut>"', () => {
    expect(computeSignature('whsec_test', 1_700_000_000, body))
      .toBe('0530ed63ef310d15ab0e728e66df8863b8346086c32b53f906162a7b72810e22');
    expect(computeSignature('whsec_test', 1_700_000_000, ''))
      .toBe('5967f3c560522fa40cf2876ebc3c3a08551dd6959aaade3b413460591895bdcc');
    expect(signatureHeader('whsec_test', 1_700_000_000, body))
      .toBe('v1=0530ed63ef310d15ab0e728e66df8863b8346086c32b53f906162a7b72810e22');
  });

  const ok = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}) =>
    verifyWebhookSignature({
      secret: 'whsec_test',
      signatureHeader: signatureHeader('whsec_test', 1_700_000_000, body),
      timestampHeader: '1700000000',
      rawBody: body,
      nowSeconds: 1_700_000_000,
      ...over,
    });

  test('vérification : signature valide acceptée', () => {
    expect(ok()).toEqual({ ok: true });
  });

  test('tolérance ±5 min : 300 s accepté, 301 s refusé (dans les deux sens)', () => {
    expect(ok({ nowSeconds: 1_700_000_300 })).toEqual({ ok: true });
    expect(ok({ nowSeconds: 1_699_999_700 })).toEqual({ ok: true });
    expect(ok({ nowSeconds: 1_700_000_301 })).toEqual({ ok: false, reason: 'stale' });
    expect(ok({ nowSeconds: 1_699_999_699 })).toEqual({ ok: false, reason: 'stale' });
  });

  test('corps modifié, mauvais secret ou horodatage rejoué → refus', () => {
    expect(ok({ rawBody: body.replace('ping', 'pong') })).toEqual({ ok: false, reason: 'mismatch' });
    expect(ok({ secret: 'autre' })).toEqual({ ok: false, reason: 'mismatch' });
    // Horodatage rafraîchi sans re-signer : la signature ne couvre plus le message.
    expect(ok({ timestampHeader: '1700000100' })).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('en-têtes absents ou malformés → refus, sans exception', () => {
    expect(ok({ signatureHeader: undefined })).toEqual({ ok: false, reason: 'malformed' });
    expect(ok({ timestampHeader: 'abc' })).toEqual({ ok: false, reason: 'malformed' });
    expect(ok({ signatureHeader: 'v0=deadbeef' })).toEqual({ ok: false, reason: 'malformed' });
    expect(ok({ signatureHeader: 'v1=zz' })).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('plusieurs signatures (rotation de schéma) : une seule valide suffit', () => {
    const good = signatureHeader('whsec_test', 1_700_000_000, body);
    expect(ok({ signatureHeader: `v1=${'0'.repeat(64)}, ${good}` })).toEqual({ ok: true });
  });

  test('secret généré : préfixe whsec_, 256 bits, jamais deux fois le même', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe('chiffrement du secret (AES-256-GCM, clé versionnée)', () => {
  const key1 = Buffer.alloc(32, 1).toString('base64');
  const key2 = Buffer.alloc(32, 2).toString('hex');

  test('aller-retour ; le chiffré ne contient pas le clair', () => {
    const ring = keyRingFromEnv({ WEBHOOK_SECRET_KEY: key1, NODE_ENV: 'production' });
    const { ciphertext, keyVersion } = encryptSecret(ring, 'sub-1', 'whsec_abc');
    expect(keyVersion).toBe(1);
    expect(ciphertext).not.toContain('whsec_abc');
    expect(decryptSecret(ring, 'sub-1', ciphertext, 1)).toBe('whsec_abc');
  });

  test('chiffré recollé sur un autre abonnement ou altéré → échec (AAD + tag)', () => {
    const ring = keyRingFromEnv({ WEBHOOK_SECRET_KEY: key1, NODE_ENV: 'production' });
    const { ciphertext } = encryptSecret(ring, 'sub-1', 'whsec_abc');
    expect(() => decryptSecret(ring, 'sub-2', ciphertext, 1)).toThrow();
    const [iv, tag, ct] = ciphertext.split('.');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret(ring, 'sub-1', `${iv}.${tag}.${flipped.toString('base64')}`, 1)).toThrow();
  });

  test('rotation de clé : l’ancienne version reste lisible, la nouvelle chiffre', () => {
    const v1 = keyRingFromEnv({ WEBHOOK_SECRET_KEY: key1, NODE_ENV: 'production' });
    const old = encryptSecret(v1, 'sub-1', 'whsec_old');
    const v2 = keyRingFromEnv({
      WEBHOOK_SECRET_KEY: key2, WEBHOOK_SECRET_KEY_VERSION: '2', WEBHOOK_SECRET_KEY_V1: key1, NODE_ENV: 'production',
    });
    expect(decryptSecret(v2, 'sub-1', old.ciphertext, 1)).toBe('whsec_old');
    const fresh = encryptSecret(v2, 'sub-1', 'whsec_new');
    expect(fresh.keyVersion).toBe(2);
    expect(decryptSecret(v2, 'sub-1', fresh.ciphertext, 2)).toBe('whsec_new');
  });

  test('en production, clé absente ou de mauvaise taille → erreur explicite', () => {
    expect(() => keyRingFromEnv({ NODE_ENV: 'production' }).key(1)).toThrow(/WEBHOOK_SECRET_KEY/);
    expect(() => keyRingFromEnv({ WEBHOOK_SECRET_KEY: 'court', NODE_ENV: 'production' }).key(1)).toThrow(/32 octets/);
  });
});

describe('échéancier de reprise', () => {
  test('1 min, 5 min, 30 min, 2 h, 12 h puis DEAD (6 tentatives)', () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);
    expect(MAX_ATTEMPTS).toBe(6);
    const t0 = new Date('2026-09-26T10:00:00Z');
    expect(nextAttemptAfterFailure(1, t0)?.toISOString()).toBe('2026-09-26T10:01:00.000Z');
    expect(nextAttemptAfterFailure(2, t0)?.toISOString()).toBe('2026-09-26T10:05:00.000Z');
    expect(nextAttemptAfterFailure(3, t0)?.toISOString()).toBe('2026-09-26T10:30:00.000Z');
    expect(nextAttemptAfterFailure(4, t0)?.toISOString()).toBe('2026-09-26T12:00:00.000Z');
    expect(nextAttemptAfterFailure(5, t0)?.toISOString()).toBe('2026-09-26T22:00:00.000Z');
    expect(nextAttemptAfterFailure(6, t0)).toBeNull();
  });

  test('seuil de désactivation : 20 par défaut, configurable, valeur absurde ignorée', () => {
    expect(disableAfterDead({})).toBe(20);
    expect(disableAfterDead({ WEBHOOKS_DISABLE_AFTER_DEAD: '3' })).toBe(3);
    expect(disableAfterDead({ WEBHOOKS_DISABLE_AFTER_DEAD: '0' })).toBe(20);
  });
});

describe('garde SSRF', () => {
  test('adresses privées, locales et réservées reconnues ; publiques acceptées', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '51.178.30.81', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  test('enregistrement : https obligatoire, pas d’identifiants, pas d’hôte local', () => {
    expect(validateWebhookUrl('https://hooks.example.com/x', false)).toBe('https://hooks.example.com/x');
    for (const bad of [
      'http://hooks.example.com/x', 'ftp://example.com', 'https://user:pw@example.com/', 'https://localhost/x',
      'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://intranet/x',
      'https://api.svc.local/x', 'pas une url',
    ]) {
      expect(() => validateWebhookUrl(bad, false), bad).toThrow(UnsafeWebhookTargetError);
    }
  });

  test('WEBHOOKS_ALLOW_PRIVATE : http et hôtes locaux permis (tests, dev)', () => {
    expect(validateWebhookUrl('http://127.0.0.1:8080/hook', true)).toBe('http://127.0.0.1:8080/hook');
  });

  let server: http.Server;
  let hits: string[];
  let port: number;
  beforeAll(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/target` });
        res.end();
        return;
      }
      res.writeHead(200).end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  test('connexion : IP littérale privée refusée avant toute socket', async () => {
    const before = hits.length;
    await expect(postWebhook(`http://127.0.0.1:${port}/x`, {}, '{}', { allowPrivate: false }))
      .rejects.toBeInstanceOf(UnsafeWebhookTargetError);
    expect(hits.length).toBe(before);
  });

  test('connexion : un NOM résolu vers une adresse privée est refusé (anti-rebinding)', async () => {
    // « localhost » résout vers 127.0.0.1/::1 sans réseau : c'est le cas d'un
    // nom public dont le DNS pointerait vers l'intérieur.
    const before = hits.length;
    await expect(postWebhook(`https://localhost:${port}/x`, {}, '{}', { allowPrivate: false }))
      .rejects.toThrow(/privée/);
    expect(hits.length).toBe(before);
  });

  test('redirection JAMAIS suivie : la 302 est renvoyée telle quelle, la cible n’est pas appelée', async () => {
    const r = await postWebhook(`http://127.0.0.1:${port}/redirect`, {}, '{}', { allowPrivate: true });
    expect(r.status).toBe(302);
    expect(hits).not.toContain('/target');
  });

  test('délai dépassé → erreur', async () => {
    const slow = http.createServer(() => { /* ne répond jamais */ });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const p = (slow.address() as AddressInfo).port;
    await expect(postWebhook(`http://127.0.0.1:${p}/`, {}, '{}', { allowPrivate: true, timeoutMs: 200 }))
      .rejects.toThrow(/délai/);
    slow.closeAllConnections();
    await new Promise((r) => slow.close(r));
  });
});

describe('charges utiles (contrat public, minimisées)', () => {
  test('registre : les six événements du brief §8 et les sept du brief §12.9 (propositions)', () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual([
      'contract.activated', 'contract.renewal_due', 'contract.renewed', 'contract.signed',
      'contract.terminated', 'pricing.revised',
      'proposal.accepted', 'proposal.converted', 'proposal.declined', 'proposal.expired', 'proposal.sent',
      'proposal.signed', 'proposal.viewed',
    ]);
  });

  test('contract.* : identifiants, références, dates, statuts — et RIEN d’autre', () => {
    const data = buildContractEventData(
      {
        id: '0192a000-0000-7000-8000-000000000001', reference: 'CT-2026-0042', type: 'MAIN', status: 'TERMINATED',
        customerId: '0192a000-0000-7000-8000-000000000002', startDate: new Date('2026-01-01T00:00:00Z'),
        endDate: null, signedAt: new Date('2025-12-15T09:30:00Z'), activatedAt: new Date('2026-01-01T00:00:00Z'),
        terminatedAt: new Date('2026-09-26T10:00:00Z'), terminationEffectiveDate: new Date('2026-12-31T00:00:00Z'),
        // champs présents sur la ligne mais qui ne doivent PAS sortir :
        ...({ title: 'Contrat de M. Dupont', amountCents: 120000n } as object),
      },
      'TERMINATION_PENDING',
      'CH-123',
    );
    expect(data.contract).toEqual({
      id: '0192a000-0000-7000-8000-000000000001', reference: 'CT-2026-0042', type: 'MAIN', status: 'TERMINATED',
      previousStatus: 'TERMINATION_PENDING', customerId: '0192a000-0000-7000-8000-000000000002',
      customerExternalRef: 'CH-123', startDate: '2026-01-01', endDate: null, signedAt: '2025-12-15T09:30:00.000Z',
      activatedAt: '2026-01-01T00:00:00.000Z', terminatedAt: '2026-09-26T10:00:00.000Z',
      terminationEffectiveDate: '2026-12-31',
    });
  });

  test('schéma strict : un champ non prévu (donnée personnelle) fait échouer la publication', () => {
    const r = ContractEventDataSchema.safeParse({ contract: { email: 'x@y.fr' } });
    expect(r.success).toBe(false);
    const r2 = WEBHOOK_EVENT_SCHEMAS['pricing.revised'].safeParse({
      contract: { id: '0192a000-0000-7000-8000-000000000001', reference: 'CT', customerId: '0192a000-0000-7000-8000-000000000002', customerExternalRef: null },
      revision: { id: '0192a000-0000-7000-8000-000000000003', scheduleId: null, effectiveDate: '2027-01-01', reason: 'INDEXATION', comment: 'libre' },
    });
    expect(r2.success).toBe(false);
  });
});
