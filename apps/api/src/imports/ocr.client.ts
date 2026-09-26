import { Injectable } from '@nestjs/common';

/**
 * Client du service OCR interne (deploy/ocr, réseau interne de la stack).
 * Contrat : 03-import-existant.md §3.
 *
 * Aucune donnée ne quitte l'infrastructure : le service tourne dans la même
 * stack, sans accès sortant. Le client ne journalise jamais le contenu.
 */
export interface OcrResult {
  readonly text: string;
  readonly pages: number;
  /** PDF recherchable : copie de travail, DISTINCTE de l'original. */
  readonly searchablePdf: Buffer;
}

export class OcrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Vrai si une nouvelle tentative a une chance d'aboutir (503, timeout, réseau). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OcrError';
  }
}

export const OCR_CLIENT = Symbol('OCR_CLIENT');

export interface OcrClientPort {
  ocr(pdf: Buffer): Promise<OcrResult>;
}

@Injectable()
export class HttpOcrClient implements OcrClientPort {
  constructor(
    private readonly baseUrl = process.env.OCR_URL ?? 'http://ocr:8080',
    private readonly timeoutMs = Number(process.env.OCR_TIMEOUT_MS ?? 330_000),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ocr(pdf: Buffer): Promise<OcrResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/ocr`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
        body: pdf,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
      throw new OcrError(timeout ? 'timeout' : 'unreachable', timeout ? 'OCR : délai dépassé' : 'OCR injoignable', true);
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
      const detail = typeof body?.detail === 'string' ? body.detail : `statut ${res.status}`;
      // 4xx : le document lui-même est en cause (pas un PDF, chiffré, trop gros)
      // — réessayer ne changera rien. 5xx : service saturé ou en panne.
      throw new OcrError(code, `OCR refusé : ${detail}`, res.status >= 500);
    }
    if (!body || typeof body.text !== 'string' || typeof body.pages !== 'number' || typeof body.pdfBase64 !== 'string') {
      throw new OcrError('bad_response', 'OCR : réponse non conforme', true);
    }
    return { text: body.text, pages: body.pages, searchablePdf: Buffer.from(body.pdfBase64, 'base64') };
  }
}
