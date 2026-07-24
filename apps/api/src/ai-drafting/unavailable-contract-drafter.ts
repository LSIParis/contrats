import { ServiceUnavailableException } from '@nestjs/common';
import type { ContractDrafter, DraftInput, DraftResult } from './contract-drafter.port.js';

/**
 * Utilisé quand ANTHROPIC_API_KEY est absente : l'app démarre normalement,
 * mais toute tentative de génération renvoie 503. Aucune dépendance au SDK.
 */
export class UnavailableContractDrafter implements ContractDrafter {
  async draft(_input: DraftInput): Promise<DraftResult> {
    throw new ServiceUnavailableException('Assistance IA non configurée.');
  }
}
