import { z } from 'zod';

/**
 * Schémas de sortie de la rédaction IA structurée — SOURCE UNIQUE.
 *
 * Le même objet Zod sert trois fois :
 * 1. à produire le JSON Schema envoyé au fournisseur (`response_format`
 *    Perplexity, `output_config.format` Claude) via `z.toJSONSchema()` ;
 * 2. à VALIDER la réponse reçue : un fournisseur qui promet de respecter le
 *    schéma peut quand même renvoyer un JSON tronqué ou non conforme
 *    (génération coupée, modèle de repli) — on ne lui fait pas confiance ;
 * 3. à typer le code (`z.infer`).
 *
 * Aucune URL n'est demandée dans la sortie : la documentation Perplexity le
 * déconseille explicitement (liens fabriqués) ; les sources viennent des
 * métadonnées de la réponse (`search_results`, annotations), cf. `drafting-sources.ts`.
 *
 * Toutes les propriétés sont `required` : chez Perplexity, une propriété non
 * requise peut revenir à `null`, ce qui compliquerait la validation pour rien.
 */

export const CLAUSE_CATEGORIES = [
  'OBJET',
  'DEFINITIONS',
  'DUREE',
  'PRIX',
  'PAIEMENT',
  'REVISION',
  'NIVEAUX_DE_SERVICE',
  'OBLIGATIONS_PRESTATAIRE',
  'OBLIGATIONS_CLIENT',
  'RESPONSABILITE',
  'ASSURANCE',
  'CONFIDENTIALITE',
  'DONNEES_PERSONNELLES',
  'SECURITE',
  'PROPRIETE_INTELLECTUELLE',
  'SOUS_TRAITANCE',
  'RESILIATION',
  'REVERSIBILITE',
  'FORCE_MAJEURE',
  'LITIGES',
  'AUTRE',
] as const;
export type ClauseCategory = (typeof CLAUSE_CATEGORIES)[number];

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

export const ClauseSchema = z.object({
  title: text(200).describe('Intitulé court de la clause, sans numéro d’article.'),
  text: text(12_000).describe('Texte intégral de la clause, en français juridique, sans URL ni référence entre crochets autre que les jetons [CLIENT], [MONTANT_n]…'),
  category: z.enum(CLAUSE_CATEGORIES),
  riskLevel: z.enum(RISK_LEVELS).describe('Risque pour le PRESTATAIRE si la clause est acceptée telle quelle.'),
  justification: text(2_000).describe('Pourquoi cette clause, et sur quel texte de droit français elle s’appuie (citer l’article, jamais une URL).'),
});
export type ClauseOutput = z.infer<typeof ClauseSchema>;

export const AnnexSchema = z.object({
  title: text(200),
  description: text(1_000),
});

export const DraftOutputSchema = z.object({
  clauses: z.array(ClauseSchema).min(1).max(60),
  suggestedAnnexes: z.array(AnnexSchema).max(20),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export const RephraseOutputSchema = z.object({
  clause: ClauseSchema,
  changes: z.array(text(500)).max(20).describe('Liste des modifications apportées, une par élément.'),
});
export type RephraseOutput = z.infer<typeof RephraseOutputSchema>;

export const ExplainOutputSchema = z.object({
  summary: text(3_000).describe('Explication en langage clair, sans jargon, pour un non-juriste.'),
  keyPoints: z.array(text(500)).max(10),
  pointsOfAttention: z.array(text(500)).max(10),
});
export type ExplainOutput = z.infer<typeof ExplainOutputSchema>;

export const CompareOutputSchema = z.object({
  closestItemId: z.string().describe('Identifiant de l’élément de bibliothèque le plus proche, ou chaîne vide si aucun.'),
  similarity: z.enum(['IDENTICAL', 'EQUIVALENT', 'DIVERGENT', 'UNRELATED']),
  differences: z
    .array(
      z.object({
        aspect: text(200),
        clause: text(1_000),
        library: text(1_000),
        riskLevel: z.enum(RISK_LEVELS),
      }),
    )
    .max(20),
  recommendation: text(2_000),
});
export type CompareOutput = z.infer<typeof CompareOutputSchema>;

export const MissingClausesOutputSchema = z.object({
  missing: z
    .array(
      z.object({
        title: text(200),
        category: z.enum(CLAUSE_CATEGORIES),
        reason: text(1_000),
        riskLevel: z.enum(RISK_LEVELS),
      }),
    )
    .max(40),
});
export type MissingClausesOutput = z.infer<typeof MissingClausesOutputSchema>;

/**
 * JSON Schema (draft 2020-12) d'un schéma Zod, sans la clé `$schema` : les
 * fournisseurs attendent l'objet schéma nu, et la clé n'apporte rien au modèle.
 */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = json;
  return rest;
}

/** Nom de schéma : 1 à 64 caractères alphanumériques (contrainte Perplexity) — `_` toléré. */
export const SCHEMA_NAMES = {
  draft: 'contract_draft_v1',
  rephrase: 'clause_rephrase_v1',
  explain: 'clause_explain_v1',
  compare: 'clause_compare_v1',
  missing: 'missing_clauses_v1',
  importExtract: 'import_extract_v1',
} as const;

/**
 * Extraction assistée des métadonnées d'un contrat IMPORTÉ (brief §3.4).
 * Chaque champ porte l'extrait EXACT du document qui le justifie ; chaîne
 * vide = non trouvé. Une valeur sans extrait retrouvé mot pour mot dans le
 * document est écartée côté serveur (garde-fou contre l'invention).
 */
const found = (desc: string) =>
  z.object({
    value: z.string().max(300).describe(desc),
    excerpt: z.string().max(400).describe('Extrait EXACT du document (copié mot pour mot) qui justifie la valeur ; chaîne vide si non trouvé.'),
  });
export const ImportExtractOutputSchema = z.object({
  dateSignature: found('Date de signature, format AAAA-MM-JJ ; chaîne vide si absente.'),
  dateEffet: found("Date de prise d'effet, format AAAA-MM-JJ ; chaîne vide si absente."),
  dureeMois: found('Durée initiale en MOIS, nombre entier écrit en chiffres ; chaîne vide si absente.'),
  reconduction: found('TACITE, EXPRESSE ou AUCUNE ; chaîne vide si le document ne dit rien.'),
  preavis: found('Préavis sous la forme « <nombre> JOURS » ou « <nombre> MOIS » ; chaîne vide si absent.'),
  montantMensuelHt: found('Montant mensuel HORS TAXES tel qu’écrit (jeton [MONTANT_n] compris) ; chaîne vide si absent.'),
  montantAnnuelHt: found('Montant annuel HORS TAXES tel qu’écrit (jeton [MONTANT_n] compris) ; chaîne vide si absent.'),
  indiceRevision: found('SYNTEC, ICHT, IPC, BT01, ILAT, ILC ou PSDC ; chaîne vide si aucun indice.'),
});
export type ImportExtractOutput = z.infer<typeof ImportExtractOutputSchema>;
