import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validation Zod d'un paramètre (`@Body(new ZodPipe(schema))`).
 *
 * Tout nouveau code d'entrée est décrit en Zod (00-architecture §4) : le même
 * schéma valide la requête ET alimente l'OpenAPI de l'API publique. Les objets
 * doivent être `.strict()` côté schéma : un champ inconnu fait échouer la
 * requête, comme le ValidationPipe global (forbidNonWhitelisted).
 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: r.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`),
      });
    }
    return r.data;
  }
}
