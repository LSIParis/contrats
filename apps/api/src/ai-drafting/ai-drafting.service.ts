import { HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { sanitizeContractHtml } from '../documents/html-sanitizer.js';
import { extractVariables } from '../templates/template-variables.js';
import { CONTRACT_DRAFTER, type ContractDrafter, type DraftInput, type DraftResult } from './contract-drafter.port.js';

/**
 * Traduit une erreur du rédacteur (port) en réponse HTTP parlante.
 *
 * Sans cela, une erreur du SDK Anthropic (ex. `AuthenticationError` sur une
 * clé invalide) n'est PAS une HttpException → le filtre global la renvoie en
 * 500 « erreur interne » opaque. On duck-type sur `.status` (les erreurs du SDK
 * portent un code HTTP) pour NE PAS coupler le service au SDK, et on rend un
 * 503 avec un message exploitable par l'opérateur (endpoint interne
 * MSP_ADMIN/LEGAL_REVIEWER, donc message précis assumé). L'erreur d'origine est
 * conservée en `cause` pour le diagnostic côté serveur.
 */
function translateDrafterError(err: unknown): HttpException {
  // Déjà une erreur HTTP (ex. UnavailableContractDrafter → 503) : propager telle quelle.
  if (err instanceof HttpException) return err;
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (status === 401 || status === 403) {
    return new ServiceUnavailableException(
      "Assistance IA : clé API Anthropic invalide ou non autorisée. Vérifiez ANTHROPIC_API_KEY dans l'environnement de la stack.",
      { cause: err instanceof Error ? err : undefined },
    );
  }
  if (status === 429) {
    return new ServiceUnavailableException(
      'Assistance IA momentanément indisponible (quota atteint). Réessayez plus tard.',
      { cause: err instanceof Error ? err : undefined },
    );
  }
  return new ServiceUnavailableException(
    'Assistance IA indisponible pour le moment. Réessayez ; si le problème persiste, vérifiez la configuration.',
    { cause: err instanceof Error ? err : undefined },
  );
}

@Injectable()
export class AiDraftingService {
  constructor(@Inject(CONTRACT_DRAFTER) private readonly drafter: ContractDrafter) {}

  async draft(input: DraftInput): Promise<DraftResult> {
    let raw: DraftResult;
    try {
      raw = await this.drafter.draft(input);
    } catch (err) {
      throw translateDrafterError(err);
    }
    const bodyHtml = sanitizeContractHtml(raw.bodyHtml);
    // Source de vérité = le HTML nettoyé ; on ignore la liste brute du modèle.
    const suggestedVariables = extractVariables(bodyHtml);
    return { bodyHtml, suggestedVariables };
  }
}
