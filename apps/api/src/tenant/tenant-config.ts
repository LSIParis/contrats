import { z } from 'zod';

/**
 * Feature flags reconnus. Toute autre clé est refusée : un drapeau n'existe
 * que s'il est déclaré ici, avec son sens. (brief : désactivés par défaut)
 */
export const FEATURE_FLAGS = {
  'contrats.ai.enabled': 'Rédaction et extraction assistées par IA (envoi de texte pseudonymisé à un fournisseur externe).',
  'contrats.docuseal.enabled': 'Signature électronique via l’instance DocuSeal.',
  'contrats.api.enabled': 'API publique /api/v1 pour les applications de la suite.',
  // Lot 9 (brief §12) : bascule progressive, sans bloquer les contrats en cours.
  'contrats.proposals.enabled': 'Propositions commerciales : rédaction, envoi, page publique, suivi, signature, conversion en contrat.',
  'contrats.proposals.required':
    'Tout nouveau contrat naît d’une proposition signée (sauf import, avenant, renouvellement, ou création directe par un administrateur, motivée).',
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
  /** Décimales du prix unitaire calculé (révision, formule, règles) — V2-H17. */
  'pricing.unitPriceScale': { schema: z.number().int().min(0).max(6), default: 6 },
  /** Règle de recherche des valeurs d'indice par défaut — V2-H18. */
  'pricing.indexLookup': { schema: z.enum(['LATEST_PUBLISHED', 'EXACT_PERIOD']), default: 'LATEST_PUBLISHED' },
  /** Ordre de signature par défaut (brief §7 : client puis LSI). */
  'signature.defaultOrder': { schema: z.enum(['CLIENT_FIRST', 'LSI_FIRST']), default: 'CLIENT_FIRST' },
  /** Délai d'expiration d'une soumission DocuSeal, en jours. */
  'signature.expireDays': { schema: z.number().int().min(1).max(365), default: 30 },
  /** Conservation après la fin du contrat, en années (prescription commerciale, art. L110-4 C. com.). */
  'retention.yearsAfterEnd': { schema: z.number().int().min(1).max(30), default: 5 },

  // --- Lot 9 : propositions commerciales (11-propositions.md, hypothèses V2-H54 à V2-H60) ---
  /** Revue interne obligatoire si une remise appliquée dépasse ce pourcentage. */
  'proposals.reviewDiscountPercent': { schema: z.number().min(0).max(100), default: 10 },
  /** Revue interne obligatoire si le total HT sur la durée d'engagement dépasse ce montant (centimes) ; null = jamais. */
  'proposals.reviewAmountCents': { schema: z.number().int().positive().nullable(), default: 3_000_000 },
  /** Acceptation par clic réservée aux propositions dont le total HT sur la durée est inférieur (centimes). */
  'proposals.clickAcceptMaxCents': { schema: z.number().int().nonnegative(), default: 500_000 },
  /** Validité par défaut, en jours après l'envoi (brief §12.11 : 30 jours). */
  'proposals.defaultValidityDays': { schema: z.number().int().min(1).max(365), default: 30 },
  /** Relances par défaut (brief §12.11) : J+3 sans ouverture, J+7 sans décision, J-2 avant expiration. */
  'proposals.followUps': {
    schema: z
      .object({
        noOpenAfterDays: z.number().int().min(1).max(90),
        noDecisionAfterDays: z.number().int().min(1).max(180),
        beforeExpiryDays: z.number().int().min(1).max(90),
      })
      .strict(),
    default: { noOpenAfterDays: 3, noDecisionAfterDays: 7, beforeExpiryDays: 2 },
  },
  /** Suivi de lecture DÉTAILLÉ conservé N jours après décision ou expiration (agrégats conservés). */
  'proposals.trackingRetentionDays': { schema: z.number().int().min(0).max(3650), default: 90 },
  /** Un lien reste ouvrable N jours après l'échéance, pour afficher le message d'expiration. */
  'proposals.linkGraceDays': { schema: z.number().int().min(0).max(365), default: 30 },
  /** Modèle d'e-mail d'envoi (balises : proposition.*, client.*, commercial.nom, destinataire.nom, lien). */
  'proposals.emailSubject': {
    schema: z.string().trim().min(3).max(200),
    default: 'Proposition {{proposition.numero}} — {{client.raisonSociale}}',
  },
  'proposals.emailBody': {
    schema: z.string().trim().min(10).max(5000).refine((v) => v.includes('{{lien}}'), 'le corps doit contenir {{lien}}'),
    default:
      'Bonjour {{destinataire.nom}},\n\n{{commercial.nom}} vous adresse la proposition {{proposition.numero}}, ' +
      'consultable jusqu’au {{proposition.dateExpiration}} à l’adresse suivante :\n{{lien}}\n\n' +
      'Ce lien vous est personnel : merci de ne pas le transférer.',
  },
  /** Signataire LSI de la contre-signature (utilisateur interne) ; null = le commercial propriétaire. */
  'proposals.lsiSignerUserId': { schema: z.string().uuid().nullable(), default: null },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown }>;
export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;
export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTINGS, k);

export const FlagBody = z.object({ enabled: z.boolean() }).strict();
export const SettingBody = z.object({ value: z.unknown() }).strict();
