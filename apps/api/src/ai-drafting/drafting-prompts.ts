import type { z } from 'zod';
import type {
  ClauseInput,
  CompareClauseInput,
  DetectMissingClausesInput,
  ExplainClauseInput,
  ImportExtractInput,
  CompanyResearchInput,
  ProposalDraftInput,
  ProposalRephraseInput,
  RephraseClauseInput,
  StructuredDraftInput,
  TemplateClauseInput,
} from './contract-drafting-provider.port.js';
import {
  CompareOutputSchema,
  DraftOutputSchema,
  ExplainOutputSchema,
  ImportExtractOutputSchema,
  CompanyResearchOutputSchema,
  ProposalDraftOutputSchema,
  ProposalRephraseOutputSchema,
  MissingClausesOutputSchema,
  RephraseOutputSchema,
  SCHEMA_NAMES,
  toProviderJsonSchema,
} from './drafting-schemas.js';

/**
 * Prompts de la rédaction IA structurée. Texte intégral reproduit dans
 * `docs/contrats/05-ia-perplexity.md` : toute modification ici doit y être
 * reportée (le prompt fait partie de ce que l'on archive et audite).
 *
 * Aucune donnée réelle ici : ni montant, ni e-mail, ni nom. Le garde-fou
 * `assertNoLeak` s'applique aussi à ces instructions.
 */

export const BASE_INSTRUCTIONS = `Tu es un assistant de rédaction juridique pour un prestataire de services informatiques français (infogérance, maintenance, support, supervision, sauvegarde externalisée, licences, RSSI/DPO externalisé).
Tu produis des PROJETS destinés à être relus et validés par un juriste. Tu n'affirmes jamais qu'une clause est valide, suffisante ou conforme ; tu signales les points à vérifier.

Droit applicable : droit français. Appuie-toi en priorité sur des sources officielles et à jour, que tu consultes avec tes outils de recherche :
- Légifrance : Code civil (notamment formation, force obligatoire et interprétation des contrats, clauses abusives dans les contrats d'adhésion, inexécution et clause pénale), Code de commerce (notamment délais et pénalités de paiement, déséquilibre significatif, rupture brutale), Code de la consommation (notamment information sur la reconduction tacite et clauses abusives, uniquement si le client est un consommateur ou un non-professionnel) ;
- CNIL : RGPD, en particulier l'article 28 (sous-traitance de données personnelles) ;
- ANSSI : recommandations de sécurité des systèmes d'information.
Si tu n'as pas pu vérifier un point sur une source officielle, écris-le dans la justification.

Données : le texte fourni contient des jetons entre crochets ([CLIENT], [PERSONNE_1], [MONTANT_1], [SIREN_1], [ADRESSE_1], [EMAIL_1], [TEL_1]…) qui remplacent des données réelles confidentielles. Recopie-les EXACTEMENT, caractère pour caractère, là où la donnée doit apparaître. N'invente jamais de valeur réelle (nom, montant, date, numéro, adresse) et n'essaie pas de deviner ce que représente un jeton.

Forme : réponds UNIQUEMENT par un objet JSON conforme au schéma fourni, en français. N'écris AUCUNE URL, aucun lien et aucun marqueur de citation ([1], [web:1]) dans les champs texte : les sources sont collectées automatiquement à partir de tes recherches. Cite les textes par leur référence (par exemple « article 1231-5 du Code civil »).`;

export const DRAFT_TASK = `Tâche : rédige un projet de contrat complet sous forme d'une liste ORDONNÉE de clauses.
Couvre au minimum, lorsque c'est pertinent pour le type de contrat : objet, définitions, durée et renouvellement, prix et révision, conditions de paiement, niveaux de service, obligations de chaque partie, responsabilité et plafond d'indemnisation, assurance, confidentialité, données personnelles (clauses de l'article 28 du RGPD si le prestataire traite des données pour le compte du client), sécurité, sous-traitance, résiliation, réversibilité, force majeure, droit applicable et litiges.
Si des clauses de contrat type sont fournies, pars d'elles : conserve leur ordre et leur esprit, adapte-les au besoin, et indique dans la justification ce que tu as modifié et pourquoi.
riskLevel mesure le risque pour le PRESTATAIRE si la clause est acceptée telle quelle (LOW, MEDIUM, HIGH).
Dans suggestedAnnexes, propose les annexes utiles (description des services, niveaux de service, barème, plan d'assurance sécurité, accord de traitement des données…), sans les rédiger.`;

export const REPHRASE_TASK = {
  reformuler: `Tâche : reformule la clause fournie pour la rendre plus claire et plus lisible, SANS en changer la portée juridique ni l'équilibre entre les parties. Liste dans changes chaque modification apportée.`,
  durcir: `Tâche : renforce la clause fournie au bénéfice du PRESTATAIRE (limitation de responsabilité, délais, conditions, exclusions), en restant dans les limites de l'ordre public et des règles sur les clauses abusives et le déséquilibre significatif. Évalue dans riskLevel le risque que la clause durcie soit réputée non écrite ou contestée. Liste dans changes chaque modification apportée.`,
} as const;

export const EXPLAIN_TASK = `Tâche : explique la clause fournie en langage clair, pour un dirigeant de PME sans formation juridique : ce qu'elle prévoit, ce qu'elle change concrètement pour chaque partie, et les points auxquels faire attention. N'emploie pas de jargon sans l'expliquer. N'utilise pas de recherche si la clause se comprend seule.`;

export const COMPARE_TASK = `Tâche : compare la clause fournie aux clauses de la bibliothèque interne fournies (chacune identifiée par un id). Désigne dans closestItemId l'id de la plus proche (chaîne vide si aucune n'est comparable), qualifie la proximité, liste les écarts de fond (pas de forme) avec leur niveau de risque pour le PRESTATAIRE, et recommande laquelle retenir ou comment les rapprocher.`;

export const MISSING_TASK = `Tâche : compare les clauses du projet avec celles du contrat type fourni et avec ce que contient habituellement un contrat de ce type en droit français. Liste uniquement les clauses ABSENTES du projet (ou vidées de leur substance), avec la raison et le risque pour le PRESTATAIRE. Ne liste pas une clause présente sous un autre titre.`;

/** Tâche structurée prête à envoyer, indépendante du fournisseur. */
export interface StructuredTask<T> {
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
  readonly jsonSchema: Record<string, unknown>;
  readonly instructions: string;
  readonly input: string;
  /** Recherche web utile ? (inutile pour expliquer ou comparer deux textes fournis). */
  readonly webSearch: boolean;
}

function task<T>(
  schemaName: string,
  schema: z.ZodType<T>,
  taskText: string,
  input: string,
  webSearch: boolean,
): StructuredTask<T> {
  return {
    schemaName,
    schema,
    jsonSchema: toProviderJsonSchema(schema),
    instructions: `${BASE_INSTRUCTIONS}\n\n${taskText}`,
    input,
    webSearch,
  };
}

function clauseBlock(c: ClauseInput | TemplateClauseInput, heading = '###'): string {
  return `${heading} ${c.title}${c.category ? ` (${c.category})` : ''}\n${c.text}`;
}

export function buildDraftTask(input: StructuredDraftInput) {
  const parts = [`Type de contrat : ${input.contractType}`, `Besoin exprimé :\n${input.needs}`];
  if (input.services.length > 0) parts.push(`Services couverts :\n${input.services.map((s) => `- ${s}`).join('\n')}`);
  if (input.templateClauses && input.templateClauses.length > 0) {
    parts.push(`Clauses du contrat type de départ :\n\n${input.templateClauses.map((c) => clauseBlock(c)).join('\n\n')}`);
  }
  return task(SCHEMA_NAMES.draft, DraftOutputSchema, DRAFT_TASK, parts.join('\n\n'), true);
}

export function buildRephraseTask(input: RephraseClauseInput) {
  const parts = [];
  if (input.contractType) parts.push(`Type de contrat : ${input.contractType}`);
  parts.push(`Clause à traiter :\n\n${clauseBlock(input.clause)}`);
  return task(SCHEMA_NAMES.rephrase, RephraseOutputSchema, REPHRASE_TASK[input.mode], parts.join('\n\n'), input.mode === 'durcir');
}

export function buildExplainTask(input: ExplainClauseInput) {
  return task(SCHEMA_NAMES.explain, ExplainOutputSchema, EXPLAIN_TASK, `Clause à expliquer :\n\n${clauseBlock(input.clause)}`, false);
}

export function buildCompareTask(input: CompareClauseInput) {
  const library = input.libraryItems.map((i) => `### id=${i.id} — ${i.title}\n${i.text}`).join('\n\n');
  return task(
    SCHEMA_NAMES.compare,
    CompareOutputSchema,
    COMPARE_TASK,
    `Clause à comparer :\n\n${clauseBlock(input.clause)}\n\nBibliothèque interne :\n\n${library}`,
    false,
  );
}

export function buildMissingClausesTask(input: DetectMissingClausesInput) {
  return task(
    SCHEMA_NAMES.missing,
    MissingClausesOutputSchema,
    MISSING_TASK,
    [
      `Type de contrat : ${input.contractType}`,
      `Clauses du projet :\n\n${input.draftClauses.map((c) => clauseBlock(c)).join('\n\n')}`,
      `Clauses du contrat type :\n\n${input.templateClauses.map((c) => clauseBlock(c)).join('\n\n')}`,
    ].join('\n\n'),
    true,
  );
}

export const IMPORT_EXTRACT_TASK = `Tâche : le texte fourni est la transcription (OCR, possiblement imparfaite) d'un contrat DÉJÀ SIGNÉ. Relève les informations demandées par le schéma, TELLES QU'ELLES FIGURENT dans le document, sans rien déduire ni compléter.
Pour chaque champ, recopie dans excerpt le passage exact (mot pour mot, y compris les fautes d'OCR et les jetons) qui justifie la valeur. Si l'information est absente ou ambiguë, laisse value ET excerpt vides.
N'utilise aucune recherche : seul le document fait foi.`;

export function buildImportExtractTask(input: ImportExtractInput) {
  return task(SCHEMA_NAMES.importExtract, ImportExtractOutputSchema, IMPORT_EXTRACT_TASK, `Document :\n\n${input.text}`, false);
}

/**
 * Propositions commerciales (lot 9.9). Socle distinct du socle juridique :
 * un texte commercial clair, jamais d'engagement chiffré inventé.
 */
export const PROPOSAL_BASE_INSTRUCTIONS = `Tu es un assistant de rédaction commerciale pour un prestataire de services informatiques français (infogérance, supervision, sauvegarde, sécurité, RSSI externalisé) qui s'adresse à des TPE et PME.
Tu produis des PROJETS relus et validés par un commercial avant tout envoi. Style : français clair, concret, sans jargon inutile ni superlatifs, vouvoiement, phrases courtes.
N'invente JAMAIS de chiffre (prix, délai, taux de disponibilité, effectif), de référence client, de certification ni d'engagement contractuel : si une information manque, écris [à compléter].
Données : le texte fourni contient des jetons entre crochets ([CLIENT], [PERSONNE_1], [MONTANT_1]…) qui remplacent des données réelles confidentielles. Recopie-les EXACTEMENT là où la donnée doit apparaître ; n'essaie pas de deviner ce qu'ils représentent.
Forme : réponds UNIQUEMENT par un objet JSON conforme au schéma fourni. N'écris aucune URL ni marqueur de citation dans les champs texte.`;

export const PROPOSAL_DRAFT_TASK = `Tâche : à partir de la prise de notes du commercial (et, si elle est fournie, de la synthèse publique sur l'entreprise), rédige les sections demandées de la proposition :
- « contexte » : la situation du client telle que décrite dans les notes ;
- « enjeux » : ce que le client doit sécuriser ou améliorer, et pourquoi c'est important pour lui ;
- « solution » : comment l'offre y répond, en termes de résultats pour le client, sans détailler les prix.
Ne rédige QUE les sections demandées. Liste dans pointsToVerify toute affirmation tirée de la synthèse publique ou déduite, que le commercial doit confirmer.`;

export const PROPOSAL_REPHRASE_TASK = {
  reformuler: `Tâche : reformule le texte fourni pour le rendre plus clair et plus convaincant, sans en changer le sens ni ajouter d'information. Liste les modifications dans changes.`,
  synthetiser: `Tâche : résume le texte fourni en un texte court (un tiers de sa longueur au plus), sans perdre d'information importante ni en ajouter. Liste dans changes ce qui a été retiré.`,
} as const;

export const COMPANY_RESEARCH_TASK = `Tâche : recherche des informations PUBLIQUES sur l'entreprise dont la raison sociale et le site web sont fournis : secteur d'activité, taille (effectif, chiffre d'affaires publiés), activité, actualités récentes. Appuie-toi sur son site, sur les registres publics (annuaire des entreprises, RNE) et sur la presse.
Ne mentionne AUCUNE personne physique (dirigeant, salarié), aucune coordonnée, aucune information non publique. Si les sources sont contradictoires ou absentes, dis-le dans la synthèse.`;

function proposalTask<T>(schemaName: string, schema: z.ZodType<T>, taskText: string, input: string, webSearch: boolean): StructuredTask<T> {
  return { schemaName, schema, jsonSchema: toProviderJsonSchema(schema), instructions: `${PROPOSAL_BASE_INSTRUCTIONS}\n\n${taskText}`, input, webSearch };
}

export function buildProposalDraftTask(input: ProposalDraftInput) {
  return proposalTask(
    SCHEMA_NAMES.proposalDraft, ProposalDraftOutputSchema, PROPOSAL_DRAFT_TASK,
    [
      `Offre : ${input.offer}`,
      `Sections demandées : ${input.sections.join(', ')}`,
      `Prise de notes du commercial :\n\n${input.notes}`,
      ...(input.research ? [`Synthèse publique sur l'entreprise (à vérifier) :\n\n${input.research}`] : []),
    ].join('\n\n'),
    false,
  );
}

export function buildProposalRephraseTask(input: ProposalRephraseInput) {
  return proposalTask(SCHEMA_NAMES.proposalRephrase, ProposalRephraseOutputSchema, PROPOSAL_REPHRASE_TASK[input.mode], `Texte :\n\n${input.text}`, false);
}

/** Recherche publique : SEULS la raison sociale et le site web partent (brief §12.3). */
export function buildCompanyResearchTask(input: CompanyResearchInput) {
  return proposalTask(
    SCHEMA_NAMES.companyResearch, CompanyResearchOutputSchema, COMPANY_RESEARCH_TASK,
    `Raison sociale : ${input.companyName}${input.website ? `\nSite web : ${input.website}` : ''}`,
    true,
  );
}
