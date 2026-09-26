import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Entrées / sorties HTTP qui dépendent de l'adaptateur (Fastify).
 *
 * Isolées ici pour que les contrôleurs ne manipulent jamais l'objet réponse
 * brut : une seule implémentation de « envoyer un fichier » et de « lire un
 * upload », donc une seule à auditer (en-têtes de sécurité compris).
 */

export interface FileResponse {
  readonly body: Buffer;
  readonly contentType: string;
  readonly filename: string;
  /** `attachment` (téléchargement) par défaut ; `inline` pour un aperçu. */
  readonly disposition?: 'attachment' | 'inline';
}

export function sendFile(res: FastifyReply, file: FileResponse): void {
  void res
    .header('Content-Type', file.contentType)
    .header('Content-Disposition', `${file.disposition ?? 'attachment'}; filename="${file.filename}"`)
    // Un document servi avec un type déclaré ne doit jamais être « deviné »
    // par le navigateur (un PDF piégé interprété en HTML = XSS).
    .header('X-Content-Type-Options', 'nosniff')
    .send(file.body);
}

/** Même forme que l'ancien `Express.Multer.File`, pour ne pas toucher au métier. */
export interface UploadedDocument {
  readonly buffer: Buffer;
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
}

/**
 * Lit une requête multipart : UN fichier (champ `fileField`) + des champs texte.
 *
 * On itère sur toutes les parties plutôt que d'appeler `req.file()` : avec
 * `req.file()`, seuls les champs placés AVANT le fichier dans le flux sont
 * visibles, et l'ordre dépend du client. Un comportement qui dépend de l'ordre
 * des champs d'un formulaire est un bug qui attend son heure.
 */
export async function readMultipart(
  req: FastifyRequest,
  fileField: string,
): Promise<{ file: UploadedDocument | undefined; fields: Record<string, string> }> {
  const { files, fields } = await readMultipartFiles(req, fileField, 1);
  return { file: files[0], fields };
}

/**
 * Variante multi-fichiers (dépôt par lot). Au-delà de `maxFiles` fichiers dans
 * le champ attendu : 400, plutôt qu'une troncature silencieuse du lot.
 */
export async function readMultipartFiles(
  req: FastifyRequest,
  fileField: string,
  maxFiles: number,
): Promise<{ files: UploadedDocument[]; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw new BadRequestException('Requête multipart/form-data attendue.');
  const fields: Record<string, string> = {};
  const files: UploadedDocument[] = [];
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.fieldname !== fileField) continue; // pièce inattendue : ignorée, jamais stockée
        if (files.length >= maxFiles) throw new BadRequestException(`Au plus ${maxFiles} fichier(s) par envoi.`);
        files.push({ buffer, originalname: part.filename, mimetype: part.mimetype, size: buffer.length });
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new PayloadTooLargeException('Fichier trop volumineux.');
    if (code === 'FST_FILES_LIMIT') throw new BadRequestException(`Au plus ${maxFiles} fichier(s) par envoi.`);
    throw e;
  }
  return { files, fields };
}

/**
 * Valide des champs de formulaire avec les MÊMES règles que le ValidationPipe
 * global (whitelist + refus des champs inconnus). Nécessaire pour le
 * multipart, que le pipe ne voit pas passer comme `@Body()`.
 */
export async function validateFields<T extends object>(cls: new () => T, fields: Record<string, string>): Promise<T> {
  const instance = plainToInstance(cls, fields);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    throw new BadRequestException(errors.flatMap((e) => Object.values(e.constraints ?? {})));
  }
  return instance;
}
