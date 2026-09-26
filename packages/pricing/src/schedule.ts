import { PricingError } from './errors.js';
import { parseDecimal, parseIsoDate } from './money.js';
import { DEFAULT_PRICING_SETTINGS, type PricingSchedule, type PricingSettings } from './types.js';

/**
 * Choix de la version de barème applicable à une date.
 *
 * Un barème est versionné : chaque version couvre [validFrom, validTo]
 * (bornes incluses, validTo null = sans fin). À une date donnée, exactement
 * UNE version doit s'appliquer. Aucune → NO_SCHEDULE ; plusieurs →
 * OVERLAPPING_SCHEDULES. On ne choisit jamais « la plus récente » en cas de
 * chevauchement : le chevauchement est une erreur de saisie qui changerait le
 * prix selon un ordre de tri, et c'est précisément ce qu'on refuse.
 */
export function selectSchedule(schedules: readonly PricingSchedule[], date: string): PricingSchedule {
  parseIsoDate(date, 'date');
  const matching = schedules.filter((s) => {
    parseIsoDate(s.validFrom, `barème ${s.id} : validFrom`);
    if (s.validTo !== null) {
      parseIsoDate(s.validTo, `barème ${s.id} : validTo`);
      if (s.validTo < s.validFrom) {
        throw new PricingError('INVALID_DATE', `Barème ${s.id} : validTo (${s.validTo}) antérieure à validFrom (${s.validFrom}).`, {
          scheduleId: s.id,
        });
      }
    }
    return s.validFrom <= date && (s.validTo === null || date <= s.validTo);
  });
  if (matching.length === 0) {
    throw new PricingError('NO_SCHEDULE', `Aucune version de barème n’est applicable au ${date}.`, { date });
  }
  if (matching.length > 1) {
    throw new PricingError(
      'OVERLAPPING_SCHEDULES',
      `Versions de barème qui se chevauchent au ${date} : ${matching.map((s) => s.id).join(', ')}.`,
      { date },
    );
  }
  return matching[0] as PricingSchedule;
}

/** Complète les paramètres par les valeurs par défaut et les vérifie. */
export function resolveSettings(partial: Partial<PricingSettings> | undefined): PricingSettings {
  const s: PricingSettings = { ...DEFAULT_PRICING_SETTINGS, ...(partial ?? {}) };
  const bad = (msg: string) => new PricingError('INVALID_SETTINGS', `Paramètres de tarification : ${msg}`);
  if (s.rounding !== 'HALF_AWAY_FROM_ZERO' && s.rounding !== 'HALF_EVEN') throw bad(`mode d’arrondi « ${String(s.rounding)} » inconnu.`);
  if (!Number.isInteger(s.unitPriceScale) || s.unitPriceScale < 0 || s.unitPriceScale > 6) {
    throw bad('unitPriceScale doit être un entier entre 0 et 6.');
  }
  if (s.indexLookup !== 'LATEST_PUBLISHED' && s.indexLookup !== 'EXACT_PERIOD') {
    throw bad(`règle d’indice « ${String(s.indexLookup)} » inconnue.`);
  }
  try {
    parseDecimal(s.overrideApprovalThresholdPercent, 'overrideApprovalThresholdPercent', { maxScale: 4 });
  } catch {
    throw bad('overrideApprovalThresholdPercent doit être un décimal positif.');
  }
  return s;
}
