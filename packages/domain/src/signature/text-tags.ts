/**
 * Balises textuelles DocuSeal — placement des champs dans le PDF. (brief §7)
 *
 * Voie nominale : on envoie le PDF FIGÉ de la version (POST
 * /submissions/pdf). DocuSeal n'a pas de modèle pour ce document : il
 * trouve les champs à faire remplir en lisant le TEXTE du PDF, sous la
 * forme `{{Nom du champ;role=Rôle;type=signature}}`. Chaque balise devient
 * un champ, attribué au signataire dont le `role` est identique.
 *
 * Syntaxe vérifiée le 2026-09-26 (docuseal.com/docs/api, guide « embedded
 * text field tags ») : attributs séparés par `;`, `type` parmi signature,
 * initials, date, datenow (date de signature, lecture seule), text… ;
 * `width`/`height` en pixels ; `required` vrai par défaut. DocuSeal RETIRE
 * les balises du document signé par défaut (`remove_tags: true`).
 *
 * Ce module est PUR : il fabrique des chaînes. Le gabarit de rendu les
 * insère (voir 06-docuseal.md §Gabarit) :
 *   - dans le bloc de signature : signature + date de signature par rôle ;
 *   - dans le PIED DE PAGE : un paraphe par rôle et par page.
 *
 * Les balises sont écrites en BLANC, petit corps : le PDF figé dont on
 * garde l'empreinte reste lisible (pas de `{{…}}` visibles à l'archive),
 * et la taille du champ est fixée par `width`/`height`, pas par la taille
 * du texte.
 */

export type SignerParty = 'LSI' | 'CLIENT';

/**
 * Libellé de rôle par partie — SOURCE UNIQUE.
 *
 * Utilisé pour la balise du document ET pour le `roleLabel` du submitter.
 * S'ils divergeaient, le signataire n'aurait aucun champ à signer — le
 * genre de bug silencieux qu'on ne voit qu'en envoyant un vrai contrat.
 */
export const SIGNER_ROLE_LABELS: Readonly<Record<SignerParty, string>> = {
  LSI: 'LSI Maintenance',
  CLIENT: 'Client',
};

export function signerRoleLabel(party: SignerParty): string {
  return SIGNER_ROLE_LABELS[party];
}

/** Types de champ que nous posons par balise. */
export type TextTagType = 'signature' | 'initials' | 'date' | 'datenow' | 'text';

export interface TextTagSpec {
  readonly name: string;
  readonly role: string;
  readonly type: TextTagType;
  readonly required?: boolean;
  readonly readonly?: boolean;
  /** Format DocuSeal, ex. `DD/MM/YYYY` pour une date. */
  readonly format?: string;
  /** Dimensions du champ, en pixels (sinon : taille du texte de la balise). */
  readonly width?: number;
  readonly height?: number;
}

/**
 * Jeton autorisé dans un nom ou un rôle de balise.
 *
 * `;`, `=`, `{` et `}` sont la GRAMMAIRE de la balise : un rôle qui en
 * contiendrait injecterait des attributs (`Client;readonly=true`) ou
 * fermerait la balise. `<`, `>`, `&`, `"` sont exclus pour qu'une balise
 * puisse être posée telle quelle dans du HTML sans échappement.
 */
const SAFE_TOKEN = /^[\p{L}\p{N} ._'’-]{1,64}$/u;
const SAFE_FORMAT = /^[A-Za-z/.\- ]{1,20}$/;

export class TextTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextTagError';
  }
}

function assertToken(what: string, value: string): void {
  if (!SAFE_TOKEN.test(value) || value.trim() !== value) {
    throw new TextTagError(`${what} de balise invalide : ${JSON.stringify(value)}`);
  }
}

function assertDimension(what: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 2000) {
    throw new TextTagError(`${what} de balise invalide : ${value}`);
  }
}

/** Fabrique une balise `{{Nom;role=…;type=…;…}}`, attributs validés. */
export function buildTextTag(spec: TextTagSpec): string {
  assertToken('Nom', spec.name);
  assertToken('Rôle', spec.role);
  const attrs = [`role=${spec.role}`, `type=${spec.type}`];
  if (spec.required === false) attrs.push('required=false');
  if (spec.readonly === true) attrs.push('readonly=true');
  if (spec.format !== undefined) {
    if (!SAFE_FORMAT.test(spec.format)) throw new TextTagError(`Format de balise invalide : ${spec.format}`);
    attrs.push(`format=${spec.format}`);
  }
  if (spec.width !== undefined) {
    assertDimension('Largeur', spec.width);
    attrs.push(`width=${spec.width}`);
  }
  if (spec.height !== undefined) {
    assertDimension('Hauteur', spec.height);
    attrs.push(`height=${spec.height}`);
  }
  return `{{${spec.name};${attrs.join(';')}}}`;
}

/** Dimensions par défaut, en pixels (page A4 ≈ 595 × 842 pt). */
export const TAG_SIZES = {
  signature: { width: 180, height: 60 },
  date: { width: 90, height: 18 },
  initials: { width: 48, height: 24 },
} as const;

/**
 * Signature du signataire de rôle `role`.
 *
 * Le nom inclut le rôle : deux signataires ne partagent jamais un même nom
 * de champ, ce qui évite toute ambiguïté d'appariement côté provider.
 */
export function signatureTag(role: string): string {
  return buildTextTag({ name: `Signature ${role}`, role, type: 'signature', ...TAG_SIZES.signature });
}

/**
 * Date de signature — `datenow` : remplie AUTOMATIQUEMENT à la signature et
 * non modifiable. Un champ `date` libre laisserait le signataire antidater.
 */
export function signingDateTag(role: string): string {
  return buildTextTag({
    name: `Date ${role}`,
    role,
    type: 'datenow',
    format: 'DD/MM/YYYY',
    ...TAG_SIZES.date,
  });
}

/**
 * Paraphe du rôle `role` sur la page `page`.
 *
 * Un nom DISTINCT par page (`Paraphe Client p3`) : chaque page porte son
 * propre champ obligatoire, le signataire paraphe donc toutes les pages.
 * `page` peut être un nombre, ou le fragment HTML que le moteur de rendu
 * remplace par le numéro de page (voir `initialsFooterHtml`) — c'est le seul
 * cas où il n'est pas validé comme un jeton.
 */
export function initialsTag(role: string, page: number | string): string {
  if (typeof page === 'number') {
    assertDimension('Page', page);
    return buildTextTag({ name: `Paraphe ${role} p${page}`, role, type: 'initials', ...TAG_SIZES.initials });
  }
  // Chemin gabarit : on construit la balise avec un marqueur, puis on insère
  // le fragment de numéro de page. Le rôle, lui, reste validé.
  const MARK = 'PAGE';
  const tag = buildTextTag({ name: `Paraphe ${role} p${MARK}`, role, type: 'initials', ...TAG_SIZES.initials });
  return tag.replace(`p${MARK};`, `p${page};`);
}

/** Style d'une balise invisible : blanc sur blanc, petit corps, sans césure. */
export const HIDDEN_TAG_STYLE = 'color:#ffffff;font-size:6pt;line-height:1;white-space:nowrap;';

/**
 * Enveloppe HTML d'une balise : texte blanc, insécable.
 *
 * Aucune échappement nécessaire : `buildTextTag` n'admet aucun caractère
 * spécial HTML. `white-space:nowrap` est ESSENTIEL : une balise coupée en
 * fin de ligne ne serait plus reconnue par DocuSeal.
 */
export function hiddenTagHtml(tag: string): string {
  return `<span class="ds-tag" style="${HIDDEN_TAG_STYLE}">${tag}</span>`;
}

/** Les balises d'un signataire pour le bloc de signature. */
export function signatureBlockTags(role: string): { readonly signature: string; readonly date: string } {
  return { signature: signatureTag(role), date: signingDateTag(role) };
}

/**
 * Pied de page portant les paraphes de TOUS les rôles, sur chaque page.
 *
 * `pageNumberHtml` est le fragment que le moteur remplace par le numéro de
 * la page courante — pour Gotenberg/Chromium : `<span class="pageNumber">`.
 * Le texte produit dans le PDF est donc, page 3 :
 * `{{Paraphe Client p3;role=Client;type=initials;…}}`.
 *
 * ⚠ Le pied de page Chromium est un document isolé : ses styles doivent y
 * être EN LIGNE, et sa taille de police explicite (défaut quasi nul).
 */
export function initialsFooterHtml(
  roles: readonly string[],
  pageNumberHtml = '<span class="pageNumber"></span>',
): string {
  if (roles.length === 0) throw new TextTagError('Aucun rôle pour le pied de page de paraphes');
  const cells = roles
    .map(
      (role) =>
        `<span style="display:inline-block;margin-left:24px;">` +
        `<span style="color:#666666;">Paraphe ${role} :</span> ` +
        hiddenTagHtml(initialsTag(role, pageNumberHtml)) +
        `</span>`,
    )
    .join('');
  return (
    `<div style="width:100%;font-size:7pt;font-family:sans-serif;text-align:right;padding:0 1.5cm;">` +
    `${cells}</div>`
  );
}
