import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Scope } from '@lsi/persistence';
import { TenantConfigService } from '../tenant/tenant-config.service.js';
import { DocusealReadiness, effectiveDocusealEnabled } from './docuseal-readiness.service.js';

/**
 * Disponibilité EFFECTIVE de la signature électronique (brief §7) :
 * drapeau du tenant `contrats.docuseal.enabled` ET instance DocuSeal
 * joignable avec un jeton valide. Si la sonde échoue, la signature est
 * neutralisée — et l'interface le dit — sans bloquer le reste de l'application.
 */
export interface SignatureAvailability {
  readonly configured: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
}

@Injectable()
export class SignatureAvailabilityService {
  constructor(
    private readonly config: TenantConfigService,
    private readonly readiness: DocusealReadiness,
  ) {}

  async get(scope: Scope): Promise<SignatureAvailability> {
    const configured = await this.config.isEnabled(scope, 'contrats.docuseal.enabled');
    const snapshot = configured ? await this.readiness.check() : this.readiness.snapshot();
    return { configured, available: snapshot?.available === true, enabled: effectiveDocusealEnabled(configured, snapshot) };
  }

  /** 503 explicite : la signature est indisponible, rien n'est envoyé. */
  async assertEnabled(scope: Scope): Promise<void> {
    const a = await this.get(scope);
    if (a.enabled) return;
    throw new ServiceUnavailableException({
      code: a.configured ? 'DOCUSEAL_UNAVAILABLE' : 'DOCUSEAL_DISABLED',
      detail: a.configured
        ? 'Le service de signature électronique est momentanément indisponible. Le contrat reste en l’état ; réessayez plus tard.'
        : 'La signature électronique n’est pas activée pour ce tenant (paramètre contrats.docuseal.enabled).',
      retryable: a.configured,
    });
  }
}
