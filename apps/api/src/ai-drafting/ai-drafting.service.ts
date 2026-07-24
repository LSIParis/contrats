import { Inject, Injectable } from '@nestjs/common';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import { extractVariables } from '../templates/template-variables.js';
import { CONTRACT_DRAFTER, type ContractDrafter, type DraftInput, type DraftResult } from './contract-drafter.port.js';

@Injectable()
export class AiDraftingService {
  constructor(@Inject(CONTRACT_DRAFTER) private readonly drafter: ContractDrafter) {}

  async draft(input: DraftInput): Promise<DraftResult> {
    const raw = await this.drafter.draft(input);
    const bodyHtml = sanitizeContractHtml(raw.bodyHtml);
    // Source de vérité = le HTML nettoyé ; on ignore la liste brute du modèle.
    const suggestedVariables = extractVariables(bodyHtml);
    return { bodyHtml, suggestedVariables };
  }
}
