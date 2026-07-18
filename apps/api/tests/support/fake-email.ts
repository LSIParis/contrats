import type { EmailMessage, EmailSender } from '@lsi/domain';

/**
 * Capture les emails au lieu de les envoyer. Permet de vérifier le contenu
 * (et d'extraire le lien du magic link) sans dépendre de Brevo.
 */
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }

  reset(): void {
    this.sent.length = 0;
  }

  /** Extrait le token du dernier magic link envoyé, ou null. */
  lastMagicToken(): string | null {
    const last = this.sent[this.sent.length - 1];
    if (!last) return null;
    const m = last.text.match(/[?&]token=([A-Za-z0-9_-]+)/);
    return m ? m[1]! : null;
  }
}
