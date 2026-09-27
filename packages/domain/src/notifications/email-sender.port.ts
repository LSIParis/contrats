/**
 * Port d'envoi d'email. (Phase B)
 *
 * Le domaine ne sait pas si les emails partent par Brevo, SES ou SMTP. Il
 * sait qu'on envoie un message à une adresse. L'adaptateur concret
 * (Brevo) vit dans infrastructure ; en test, un fake capture les envois.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  /** Corps texte (obligatoire) + HTML (optionnel). */
  readonly text: string;
  readonly html?: string;
  /**
   * Nom d'expéditeur affiché (lot 9 : « au nom du commercial »). L'adresse
   * d'expédition reste celle du domaine (SPF / DKIM / DMARC respectés).
   */
  readonly fromName?: string;
  /** Adresse de réponse (le commercial), distincte de l'expéditeur technique. */
  readonly replyTo?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}
