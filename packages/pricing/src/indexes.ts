import { PricingError } from './errors.js';
import { parseDecimal, parseIsoDate, parsePeriod } from './money.js';
import type { IndexLookupRule, PriceIndex } from './types.js';

/**
 * Recherche d'une valeur d'indice à une date. (brief §5, révision)
 *
 * Aucune valeur n'est codée en dur ni interpolée : les valeurs viennent des
 * données (saisies ou importées par un connecteur). Absente → erreur typée
 * INDEX_VALUE_NOT_FOUND. Un indice deviné produirait une révision fausse et
 * juridiquement contestable ; une erreur, elle, se corrige en saisissant la
 * valeur manquante.
 *
 * Deux règles, choisies explicitement (paramètre du tenant ou de la ligne) :
 *
 *  - LATEST_PUBLISHED (défaut) : la valeur de la période la plus récente qui
 *    soit à la fois ≤ au mois de la date ET publiée au plus tard à cette date
 *    (`publishedAt ≤ date`). C'est « le dernier indice connu à la date » :
 *    rejouer le calcul plus tard donne le même résultat, même si de nouvelles
 *    valeurs ont été publiées depuis.
 *
 *  - EXACT_PERIOD : la valeur de la période du mois de la date, et elle
 *    seule. La date de publication est ignorée : c'est le cas des clauses
 *    « indice du mois d'août de l'année N », où la période est nommée par le
 *    contrat. Si la valeur n'existe pas (encore), erreur.
 */

export interface IndexObservation {
  readonly indexCode: string;
  readonly indexName: string;
  readonly requestedDate: string;
  readonly rule: IndexLookupRule;
  readonly period: string;
  /** Valeur telle que saisie (chaîne décimale). */
  readonly value: string;
  readonly publishedAt: string;
}

export function lookupIndexValue(
  indexes: readonly PriceIndex[],
  indexCode: string,
  date: string,
  rule: IndexLookupRule,
): IndexObservation {
  parseIsoDate(date, `indice ${indexCode} : date`);
  const index = indexes.find((i) => i.code === indexCode);
  if (!index) {
    throw new PricingError('INDEX_NOT_FOUND', `Indice « ${indexCode} » inconnu : aucune série fournie sous ce code.`, { indexCode });
  }

  const seen = new Set<string>();
  for (const v of index.values) {
    parsePeriod(v.period, `indice ${indexCode} : période`);
    parseIsoDate(v.publishedAt, `indice ${indexCode} ${v.period} : publishedAt`);
    parseDecimal(v.value, `indice ${indexCode} ${v.period} : valeur`, { maxScale: 10 });
    if (seen.has(v.period)) {
      throw new PricingError('DUPLICATE_INDEX_VALUE', `Indice ${indexCode} : deux valeurs pour la période ${v.period}.`, {
        indexCode,
        period: v.period,
      });
    }
    seen.add(v.period);
  }

  const targetPeriod = date.slice(0, 7);
  const found =
    rule === 'EXACT_PERIOD'
      ? index.values.find((v) => v.period === targetPeriod)
      : index.values
          .filter((v) => v.period <= targetPeriod && v.publishedAt <= date)
          .reduce<(typeof index.values)[number] | undefined>((best, v) => (!best || v.period > best.period ? v : best), undefined);

  if (!found) {
    const detail =
      rule === 'EXACT_PERIOD'
        ? `aucune valeur pour la période ${targetPeriod}`
        : `aucune valeur publiée au ${date} pour une période ≤ ${targetPeriod}`;
    throw new PricingError('INDEX_VALUE_NOT_FOUND', `Indice ${indexCode} : ${detail}. Saisir ou importer la valeur manquante.`, {
      indexCode,
      date,
      rule,
    });
  }

  return {
    indexCode,
    indexName: index.name,
    requestedDate: date,
    rule,
    period: found.period,
    value: found.value,
    publishedAt: found.publishedAt,
  };
}
