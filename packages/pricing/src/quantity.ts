import { PricingError } from './errors.js';
import { parseDecimal, parseIsoDate } from './money.js';
import { selectSchedule } from './schedule.js';
import type { PricingInput, ResolvedQuantity } from './types.js';

/**
 * Fournisseurs de quantités. (brief §5 « Quantités »)
 *
 * Une quantité peut venir d'une autre application de la suite — typiquement
 * le nombre de postes supervisés remonté par le RMM de Client Help. Cet appel
 * est asynchrone et faillible ; priceAt, lui, doit rester synchrone et pur.
 * D'où deux étapes distinctes :
 *
 *   const quantities = await resolveQuantities(input, contractRef, date, provider); // E/S
 *   const result     = priceAt({ ...input, quantities }, date);                     // pur
 *
 * Les quantités résolues (avec leur provenance et leur instant d'observation)
 * sont conservées dans la trace : on sait, pour chaque ligne, d'où vient le
 * « 42 postes » facturé.
 *
 * Seule l'interface et une implémentation factice sont livrées. Le
 * branchement réel (RMM de Client Help) est documenté dans
 * docs/contrats/04-tarification.md §9, sans supposer la forme de son API.
 */

export interface QuantityObservation {
  /** Chaîne décimale positive. */
  readonly quantity: string;
  /** Provenance lisible, reportée dans la trace (« rmm:client-help », « fake »). */
  readonly source: string;
  /** Instant d'observation ISO 8601, ou null si inconnu. */
  readonly observedAt: string | null;
}

export interface QuantityProvider {
  /**
   * Quantité de l'article `articleCode` pour le contrat `contractRef`,
   * applicable à la date calendaire `date` (YYYY-MM-DD).
   * DOIT rejeter (et non renvoyer 0) si la quantité est inconnue.
   */
  getQuantity(contractRef: string, articleCode: string, date: string): Promise<QuantityObservation>;
}

export interface FakeQuantityEntry {
  readonly contractRef: string;
  readonly articleCode: string;
  /** La quantité s'applique à partir de cette date (incluse). */
  readonly effectiveFrom: string;
  readonly quantity: string;
  readonly observedAt?: string;
}

/**
 * Implémentation en mémoire, pour les tests, la démonstration et le
 * simulateur. Retient, pour (contrat, article), l'entrée la plus récente
 * dont `effectiveFrom ≤ date`. Aucune → QUANTITY_UNAVAILABLE.
 */
export class FakeQuantityProvider implements QuantityProvider {
  readonly calls: { contractRef: string; articleCode: string; date: string }[] = [];

  constructor(
    private readonly entries: readonly FakeQuantityEntry[],
    private readonly source = 'fake',
  ) {}

  getQuantity(contractRef: string, articleCode: string, date: string): Promise<QuantityObservation> {
    this.calls.push({ contractRef, articleCode, date });
    const best = this.entries
      .filter((e) => e.contractRef === contractRef && e.articleCode === articleCode && e.effectiveFrom <= date)
      .reduce<FakeQuantityEntry | undefined>((b, e) => (!b || e.effectiveFrom > b.effectiveFrom ? e : b), undefined);
    if (!best) {
      return Promise.reject(
        new PricingError(
          'QUANTITY_UNAVAILABLE',
          `Aucune quantité connue pour ${contractRef} / ${articleCode} au ${date}.`,
          { contractRef, articleCode, date },
        ),
      );
    }
    return Promise.resolve({ quantity: best.quantity, source: this.source, observedAt: best.observedAt ?? null });
  }
}

/**
 * Résout les quantités des lignes PROVIDER du barème applicable à `date`.
 * Appels SÉQUENTIELS dans l'ordre du barème : l'ordre des appels (et des
 * journaux) est déterministe ; un barème compte quelques lignes, le
 * parallélisme n'apporterait rien de mesurable.
 */
export async function resolveQuantities(
  input: Pick<PricingInput, 'schedules'>,
  contractRef: string,
  date: string,
  provider: QuantityProvider,
): Promise<ResolvedQuantity[]> {
  parseIsoDate(date, 'date');
  const schedule = selectSchedule(input.schedules, date);
  const out: ResolvedQuantity[] = [];
  for (const line of schedule.lines) {
    if (line.kind === 'DISCOUNT' || line.quantity?.source !== 'PROVIDER') continue;
    const articleCode = line.quantity.articleCode ?? line.code;
    let obs: QuantityObservation;
    try {
      obs = await provider.getQuantity(contractRef, articleCode, date);
      parseDecimal(obs.quantity, `ligne ${line.id} : quantité fournie par ${obs.source}`);
    } catch (e) {
      if (e instanceof PricingError && e.details.lineId === undefined) {
        throw new PricingError(e.code, `Ligne ${line.id} : ${e.message}`, { ...e.details, lineId: line.id });
      }
      throw e;
    }
    out.push({ lineId: line.id, quantity: obs.quantity, source: obs.source, observedAt: obs.observedAt });
  }
  return out;
}
