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
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}
