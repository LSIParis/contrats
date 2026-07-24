import { describe, test, expect } from 'vitest';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { AiDraftingService } from '../../src/ai-drafting/ai-drafting.service.js';
import type { ContractDrafter, DraftResult } from '../../src/ai-drafting/contract-drafter.port.js';

const fakeDrafter: ContractDrafter = {
  async draft() {
    return {
      bodyHtml: '<p>Bonjour {{client_nom}}, montant {{montant}}.</p><script>alert(1)</script>',
      suggestedVariables: ['ignore_moi'],
    };
  },
};

/** Drafter qui lève une erreur donnée (imite les erreurs du SDK Anthropic). */
function throwingDrafter(err: unknown): ContractDrafter {
  return { async draft(): Promise<DraftResult> { throw err; } };
}
/** Erreur façon SDK Anthropic : une Error avec un `.status` numérique. */
function apiError(status: number): Error {
  const e = new Error(`${status} upstream`);
  (e as { status?: number }).status = status;
  return e;
}

describe('AiDraftingService', () => {
  test('sanitise le HTML et ré-extrait les variables du HTML nettoyé', async () => {
    const svc = new AiDraftingService(fakeDrafter);
    const res = await svc.draft({ prompt: 'Un contrat de maintenance' });
    expect(res.bodyHtml).not.toContain('<script>');
    expect(res.bodyHtml).toContain('{{client_nom}}');
    // dérivées du HTML nettoyé, pas de la liste brute du modèle
    expect(res.suggestedVariables).toEqual(['client_nom', 'montant']);
  });

  test('clé API invalide (401) → 503 avec un message parlant, pas un 500', async () => {
    const svc = new AiDraftingService(throwingDrafter(apiError(401)));
    await expect(svc.draft({ prompt: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.draft({ prompt: 'x' })).rejects.toThrow(/ANTHROPIC_API_KEY|clé API/i);
  });

  test('403 non autorisé → 503 (même famille : problème de clé)', async () => {
    const svc = new AiDraftingService(throwingDrafter(apiError(403)));
    await expect(svc.draft({ prompt: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  test('quota atteint (429) → 503 « momentanément indisponible »', async () => {
    const svc = new AiDraftingService(throwingDrafter(apiError(429)));
    await expect(svc.draft({ prompt: 'x' })).rejects.toThrow(/quota|momentanément/i);
  });

  test('erreur SDK générique (500) → 503, jamais propagée en 500 brut', async () => {
    const svc = new AiDraftingService(throwingDrafter(apiError(500)));
    await expect(svc.draft({ prompt: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  test('erreur sans status (ex. parsing) → 503', async () => {
    const svc = new AiDraftingService(throwingDrafter(new Error('Réponse IA non exploitable.')));
    await expect(svc.draft({ prompt: 'x' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  test('une HttpException du drafter (ex. 503 « non configurée ») est propagée telle quelle', async () => {
    const original = new ServiceUnavailableException('Assistance IA non configurée.');
    const svc = new AiDraftingService(throwingDrafter(original));
    await expect(svc.draft({ prompt: 'x' })).rejects.toBe(original);
    // pas de double-emballage
    await expect(svc.draft({ prompt: 'x' })).rejects.toBeInstanceOf(HttpException);
  });
});
