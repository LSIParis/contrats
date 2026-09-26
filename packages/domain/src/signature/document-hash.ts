/**
 * Lien d'empreintes entre le document ENVOYÉ et le document SIGNÉ. (brief §7)
 *
 * Le brief demande de vérifier, après signature, que l'empreinte du document
 * renvoyé correspond à la version envoyée « hors surcouche de signature »,
 * ou à défaut de conserver les deux empreintes et le lien entre elles.
 *
 * En pratique, DocuSeal RÉÉCRIT le PDF : il y dessine les champs remplis
 * (signatures, paraphes, dates), retire les balises `{{…}}` et appose sa
 * signature numérique de scellement. Le SHA-256 du PDF signé diffère donc
 * TOUJOURS de celui du PDF envoyé. Isoler « le document hors surcouche »
 * exigerait d'interpréter le PDF (flux de contenu, révisions) — fragile, et
 * sans valeur probante supérieure.
 *
 * Politique retenue (06-docuseal.md §Empreintes) : on CONSERVE les deux
 * empreintes et on qualifie leur relation.
 *   IDENTICAL       le provider a renvoyé exactement les octets envoyés
 *                   (aucune surcouche : anormal pour un document signé,
 *                   à surveiller — mais pas une altération) ;
 *   SIGNED_OVERLAY  le document signé est un DÉRIVÉ du document envoyé.
 *                   Le lien est établi par la chaîne : empreinte envoyée
 *                   stockée AVANT l'envoi → submission du provider → PDF
 *                   signé rapatrié et haché → journal d'audit du provider,
 *                   rapatrié et haché lui aussi.
 *
 * Pure : prend des empreintes, pas des octets. Le calcul du SHA-256 reste
 * dans l'infrastructure (Node crypto), le domaine décide de la relation.
 */

export type DocumentHashRelation = 'IDENTICAL' | 'SIGNED_OVERLAY';

export interface DocumentHashLink {
  readonly sentSha256: string;
  readonly signedSha256: string;
  readonly relation: DocumentHashRelation;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

export class DocumentHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentHashError';
  }
}

/** Normalise en hexadécimal minuscule et REFUSE ce qui n'est pas un SHA-256. */
function normalize(what: string, value: string): string {
  const v = value.trim().toLowerCase();
  if (!isSha256Hex(v)) throw new DocumentHashError(`${what} n'est pas un SHA-256 hexadécimal : ${JSON.stringify(value)}`);
  return v;
}

/**
 * Qualifie la relation entre l'empreinte envoyée et l'empreinte signée.
 *
 * Lève si l'une des deux n'est pas un SHA-256 : un lien de preuve construit
 * sur une empreinte malformée serait pire que pas de lien du tout.
 */
export function linkDocumentHashes(sentSha256: string, signedSha256: string): DocumentHashLink {
  const sent = normalize('Empreinte envoyée', sentSha256);
  const signed = normalize('Empreinte signée', signedSha256);
  return {
    sentSha256: sent,
    signedSha256: signed,
    relation: sent === signed ? 'IDENTICAL' : 'SIGNED_OVERLAY',
  };
}
