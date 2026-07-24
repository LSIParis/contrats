import { describe, test, expect } from 'vitest';
import { AiDraftingService } from '../../src/ai-drafting/ai-drafting.service.js';
import type { ContractDrafter } from '../../src/ai-drafting/contract-drafter.port.js';

const fakeDrafter: ContractDrafter = {
  async draft() {
    return {
      bodyHtml: '<p>Bonjour {{client_nom}}, montant {{montant}}.</p><script>alert(1)</script>',
      suggestedVariables: ['ignore_moi'],
    };
  },
};

describe('AiDraftingService', () => {
  test('sanitise le HTML et ré-extrait les variables du HTML nettoyé', async () => {
    const svc = new AiDraftingService(fakeDrafter);
    const res = await svc.draft({ prompt: 'Un contrat de maintenance' });
    expect(res.bodyHtml).not.toContain('<script>');
    expect(res.bodyHtml).toContain('{{client_nom}}');
    // dérivées du HTML nettoyé, pas de la liste brute du modèle
    expect(res.suggestedVariables).toEqual(['client_nom', 'montant']);
  });
});
