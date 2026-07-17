/**
 * Port de génération documentaire. (§11.2)
 *
 * Le domaine ne sait pas que le rendu passe par Gotenberg, ni que Gotenberg
 * est un Chromium en conteneur. Il sait qu'on transforme du HTML en PDF.
 */

export interface RenderRequest {
  readonly html: string;
  readonly documentTitle: string;
}

export interface RenderedDocument {
  readonly pdf: Buffer;
  /**
   * SHA-256 du PDF, calculé à la génération.
   *
   * C'est lui qui permet d'affirmer plus tard « le document envoyé est
   * exactement celui-ci » (§11.6). Sans hash pré-envoi, on ne prouve que
   * ce que le provider veut bien nous dire.
   */
  readonly sha256: string;
}

export interface DocumentRenderer {
  /**
   * HTML → PDF/A-2b.
   *
   * PDF/A et non PDF classique : format d'archivage normalisé, polices
   * embarquées, aucun contenu externe. Un contrat qui ne s'affiche plus
   * dans 8 ans n'est pas une preuve.
   */
  render(req: RenderRequest): Promise<RenderedDocument>;
}
