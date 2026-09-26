import { z } from 'zod';

/**
 * Feature flags reconnus. Toute autre clé est refusée : un drapeau n'existe
 * que s'il est déclaré ici, avec son sens. (brief : désactivés par défaut)
 */
export const FEATURE_FLAGS = {
  'contrats.ai.enabled': 'Rédaction et extraction assistées par IA (envoi de texte pseudonymisé à un fournisseur externe).',
  'contrats.docuseal.enabled': 'Signature électronique via l’instance DocuSeal.',
  'contrats.api.enabled': 'API publique /api/v1 pour les applications de la suite.',
} as const;
export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const isFeatureFlag = (k: string): k is FeatureFlag => Object.hasOwn(FEATURE_FLAGS, k);

/**
 * Paramètres de tenant : UN schéma Zod et UNE valeur par défaut par clé.
 * La valeur par défaut est celle retenue dans docs/contrats/00-architecture.md
 * (Hypothèses) ; la modifier ici change le comportement de tous les tenants
 * qui ne l'ont pas surchargée.
 *
 * Aucun secret : les clés d'API restent dans l'environnement du conteneur.
 */
export const SETTINGS = {
  /** Fournisseur de rédaction IA (V2-H7) : Perplexity par défaut, Claude possible. */
  'ai.provider': { schema: z.enum(['perplexity', 'claude']), default: 'perplexity' },
  /** Modèle ou preset : jamais codé en dur (brief §6). null = défaut du fournisseur. */
  'ai.model': { schema: z.string().trim().min(1).max(120).nullable(), default: null },
  'ai.preset': { schema: z.string().trim().min(1).max(120).nullable(), default: null },
  /** Budget mensuel en USD (usage renvoyé par le fournisseur). null = illimité. */
  'ai.monthlyBudgetUsd': { schema: z.number().nonnegative().max(100_000).nullable(), default: null },
  /** Seuils d'alerte d'échéance, en jours (V2-H12). */
  'alerts.thresholdsDays': {
    schema: z.array(z.number().int().positive().max(730)).min(1).max(10),
    default: [90, 60, 30, 7],
  },
  /** Règle d'arrondi au centime (V2-H9). */
  'pricing.rounding': { schema: z.enum(['HALF_AWAY_FROM_ZERO', 'HALF_EVEN']), default: 'HALF_AWAY_FROM_ZERO' },
  /** Écart (%) au-delà duquel une dérogation tarifaire exige une seconde validation. */
  'pricing.overrideApprovalThresholdPercent': { schema: z.number().min(0).max(1000), default: 10 },
  /** Ordre de signature par défaut (brief §7 : client puis LSI). */
  'signature.defaultOrder': { schema: z.enum(['CLIENT_FIRST', 'LSI_FIRST']), default: 'CLIENT_FIRST' },
  /** Délai d'expiration d'une soumission DocuSeal, en jours. */
  'signature.expireDays': { schema: z.number().int().min(1).max(365), default: 30 },
  /** Conservation après la fin du contrat, en années (prescription commerciale, art. L110-4 C. com.). */
  'retention.yearsAfterEnd': { schema: z.number().int().min(1).max(30), default: 5 },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown }>;
export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;
export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTINGS, k);

export const FlagBody = z.object({ enabled: z.boolean() }).strict();
export const SettingBody = z.object({ value: z.unknown() }).strict();
