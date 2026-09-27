/**
 * Balises de fusion des propositions (brief §12.3) : `{{client.raisonSociale}}`…
 *
 * TYPÉES et VALIDÉES avant envoi : une balise inconnue est une erreur de
 * rédaction, une balise sans valeur bloque le passage à PRÊTE — aucune balise
 * non résolue ne part chez le client. Le catalogue est la source unique :
 * l'éditeur, le rendu et la validation le partagent.
 *
 * Module PUR : il remplace des chaînes. Les valeurs viennent de la couche
 * applicative (client, contact, commercial, parc, totaux du moteur).
 */

export type MergeTagType = 'text' | 'integer' | 'date' | 'money';

export interface MergeTagDefinition {
  readonly type: MergeTagType;
  readonly label: string;
}

export const MERGE_TAG_CATALOG: Readonly<Record<string, MergeTagDefinition>> = {
  'client.raisonSociale': { type: 'text', label: 'Raison sociale du client' },
  'client.siren': { type: 'text', label: 'SIREN du client' },
  'client.effectif': { type: 'integer', label: 'Effectif du client' },
  'contact.civilite': { type: 'text', label: 'Civilité du contact' },
  'contact.nom': { type: 'text', label: 'Nom du contact' },
  'contact.prenom': { type: 'text', label: 'Prénom du contact' },
  'commercial.nom': { type: 'text', label: 'Nom du commercial' },
  'proposition.numero': { type: 'text', label: 'Numéro de la proposition' },
  'proposition.dateExpiration': { type: 'date', label: 'Date d’expiration' },
  'parc.nbPostes': { type: 'integer', label: 'Nombre de postes' },
  'parc.nbServeurs': { type: 'integer', label: 'Nombre de serveurs' },
  'parc.nbEquipementsReseau': { type: 'integer', label: 'Nombre d’équipements réseau' },
  'parc.nbUtilisateursM365': { type: 'integer', label: 'Nombre d’utilisateurs Microsoft 365' },
  'tarif.totalPonctuelHT': { type: 'money', label: 'Total ponctuel HT' },
  'tarif.totalMensuelHT': { type: 'money', label: 'Total mensuel récurrent HT' },
  'tarif.totalEngagementHT': { type: 'money', label: 'Total sur la durée d’engagement HT' },
  'engagement.dureeMois': { type: 'integer', label: 'Durée d’engagement (mois)' },
};

const TAG_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export type MergeValues = Readonly<Record<string, string | number | null | undefined>>;

/** Balises présentes dans un texte, dans l'ordre (doublons conservés). */
export function findMergeTags(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(TAG_RE)].map((m) => m[1] as string);
}

/** Balises absentes du catalogue. */
export function unknownMergeTags(text: string | null | undefined): string[] {
  return [...new Set(findMergeTags(text).filter((t) => !Object.hasOwn(MERGE_TAG_CATALOG, t)))];
}

const NUMBER_FR = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const MONEY_FR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/**
 * Valeur affichable d'une balise, ou null si elle manque ou est mal typée
 * (on n'affiche jamais « NaN » ni « undefined » chez le client).
 *   - money : centimes ENTIERS (sortie du moteur) → « 1 515,00 € » ;
 *   - date  : « YYYY-MM-DD » → « 31/10/2026 » (jour calendaire, sans fuseau).
 */
export function formatMergeValue(tag: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const def = MERGE_TAG_CATALOG[tag];
  if (!def) return null;
  switch (def.type) {
    case 'text':
      return String(value);
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isInteger(n) ? NUMBER_FR.format(n) : null;
    }
    case 'money': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isInteger(n) ? MONEY_FR.format(n / 100) : null;
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface RenderedMergeText {
  readonly text: string;
  /** Balises sans valeur (ou inconnues), sans doublon : elles bloquent l'envoi. */
  readonly unresolved: string[];
}

/**
 * Remplace les balises par leurs valeurs. Une balise sans valeur est laissée
 * TELLE QUELLE (visible dans l'aperçu) et listée dans `unresolved`.
 * `html: true` échappe les valeurs (le texte cible est du HTML).
 */
export function renderMergeTags(
  text: string | null | undefined,
  values: MergeValues,
  opts: { readonly html?: boolean } = {},
): RenderedMergeText {
  const unresolved = new Set<string>();
  const out = (text ?? '').replace(TAG_RE, (whole, tag: string) => {
    const v = formatMergeValue(tag, values[tag]);
    if (v === null) {
      unresolved.add(tag);
      return whole;
    }
    return opts.html ? escapeHtml(v) : v;
  });
  return { text: out, unresolved: [...unresolved] };
}
