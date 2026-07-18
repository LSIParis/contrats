import { Injectable, Logger } from '@nestjs/common';
import type { EmailMessage, EmailSender } from '@lsi/domain';

/**
 * Adaptateur email Brevo (ex-Sendinblue). (Phase B)
 *
 * Service transactionnel français (souveraineté). API REST simple.
 *
 * ⚠ NON TESTÉ automatiquement : les tests utilisent un FakeEmailSender. Cet
 * adaptateur exige une clé API réelle + un domaine expéditeur vérifié
 * (SPF/DKIM/DMARC sur lsi-maintenance.fr). À valider contre l'API réelle au
 * moment du câblage — comme Gotenberg et DocuSeal l'ont été.
 */
@Injectable()
export class BrevoSender implements EmailSender {
  private readonly log = new Logger(BrevoSender.name);

  private get apiKey(): string {
    const k = process.env.BREVO_API_KEY;
    if (!k) throw new Error('BREVO_API_KEY absent — envoi d’email impossible');
    return k;
  }

  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: {
          name: process.env.EMAIL_FROM_NAME ?? 'LSI Maintenance',
          email: process.env.EMAIL_FROM ?? 'contrats@lsi-maintenance.fr',
        },
        to: [{ email: msg.to }],
        subject: msg.subject,
        textContent: msg.text,
        ...(msg.html ? { htmlContent: msg.html } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Brevo a répondu ${res.status} : ${body.slice(0, 200)}`);
    }
  }
}
