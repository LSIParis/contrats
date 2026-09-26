import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ESignatureProvider, ProviderReadiness } from '@lsi/domain';
import { ESIGNATURE_PROVIDER } from './provider.token.js';

/**
 * Disponibilité de DocuSeal — mode dégradé. (brief §7, 06-docuseal.md §Readiness)
 *
 * Au démarrage puis à la demande (sonde /readyz), on vérifie que l'API
 * DocuSeal répond ET que le jeton est accepté. Le résultat est MIS EN CACHE :
 * une sonde de santé interrogée toutes les 10 s par Uptime Kuma ne doit pas
 * se traduire par un appel DocuSeal toutes les 10 s.
 *
 * DocuSeal indisponible ne rend PAS l'application indisponible : /readyz
 * reste 200 (le reste de l'application fonctionne), mais le flag
 * `contrats.docuseal.enabled` est NEUTRALISÉ via `effectiveDocusealEnabled`,
 * et l'interface l'indique. Un fournisseur de signature en panne ne doit pas
 * empêcher de consulter ses contrats.
 */

export interface DocusealReadinessSnapshot extends ProviderReadiness {
  /** reachable && tokenValid. */
  readonly available: boolean;
  readonly checkedAt: Date;
}

/** Durée de validité du cache, en millisecondes. */
const TTL_MS = Number(process.env.DOCUSEAL_READINESS_TTL_MS) > 0 ? Number(process.env.DOCUSEAL_READINESS_TTL_MS) : 60_000;

/**
 * Valeur EFFECTIVE du flag `contrats.docuseal.enabled`.
 *
 * Pure, pour que le module de feature flags (lot suivant) l'applique sans
 * connaître DocuSeal : un flag activé par le tenant reste neutralisé tant que
 * la sonde n'a pas confirmé la disponibilité. Inconnu (jamais sondé) = NON
 * disponible : on ne promet pas une signature qu'on n'a pas vérifiée.
 */
export function effectiveDocusealEnabled(
  configuredFlag: boolean,
  readiness: Pick<DocusealReadinessSnapshot, 'available'> | null,
): boolean {
  return configuredFlag && readiness?.available === true;
}

@Injectable()
export class DocusealReadiness implements OnModuleInit {
  private readonly log = new Logger(DocusealReadiness.name);
  private cached: DocusealReadinessSnapshot | null = null;
  private inflight: Promise<DocusealReadinessSnapshot> | null = null;

  constructor(@Inject(ESIGNATURE_PROVIDER) private readonly provider: ESignatureProvider) {}

  /**
   * Sonde au démarrage — sans BLOQUER le démarrage : on n'attend pas la
   * réponse. Désactivée sous Vitest (aucun appel réseau en test).
   */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DOCUSEAL_READINESS_ON_START === 'false') return;
    void this.refresh().catch(() => undefined);
  }

  /** Force une nouvelle sonde (dédupliquée si une sonde est déjà en vol). */
  async refresh(): Promise<DocusealReadinessSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const r = await this.provider.checkReadiness().catch(
        (e: unknown): ProviderReadiness => ({ reachable: false, tokenValid: false, detail: (e as Error).message }),
      );
      const snap: DocusealReadinessSnapshot = { ...r, available: r.reachable && r.tokenValid, checkedAt: new Date() };
      if (this.cached?.available !== snap.available) {
        // Journalisé au CHANGEMENT d'état seulement : pas un log par sonde.
        const msg = `DocuSeal ${snap.available ? 'disponible' : 'INDISPONIBLE — signature électronique neutralisée'} (${snap.detail})`;
        if (snap.available) this.log.log(msg);
        else this.log.warn(msg);
      }
      this.cached = snap;
      return snap;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** État récent (cache ≤ TTL), sonde si périmé. Ne lève jamais. */
  async check(maxAgeMs = TTL_MS): Promise<DocusealReadinessSnapshot> {
    if (this.cached && Date.now() - this.cached.checkedAt.getTime() < maxAgeMs) return this.cached;
    return this.refresh();
  }

  /** Dernier état connu, SANS appel réseau. `null` : jamais sondé. */
  snapshot(): DocusealReadinessSnapshot | null {
    return this.cached;
  }

  /** Synchrone, pour les gardes et les flags : dernier état connu. */
  isAvailable(): boolean {
    return this.cached?.available === true;
  }
}
