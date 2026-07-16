import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';

/**
 * Sérialise les BigInt en nombres JSON.
 *
 * Les montants sont stockés en centimes ENTIERS (BigInt côté Prisma) : on ne
 * stocke pas de la monnaie en flottant. Mais JSON.stringify lève sur un
 * BigInt — sans cet intercepteur, le premier contrat portant un montant
 * renvoie 500.
 *
 * Détecté par tests/isolation/idor.test.ts. Un bug qu'aucune revue de code
 * n'aurait vu : le type est correct, le service est correct, et la panne
 * n'existe qu'au moment de la sérialisation HTTP.
 *
 * BigInt → Number est sûr ici : les entiers JSON sont exacts jusqu'à 2^53,
 * soit ~90 000 milliards d'euros en centimes. Au-delà, LSI aura d'autres
 * problèmes. On convertit plutôt qu'on ne sérialise en chaîne, pour que les
 * clients JS puissent calculer sans reparser.
 */
@Injectable()
export class BigIntInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => convert(data)));
  }
}

function convert(value: unknown): unknown {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      // Perdre silencieusement de la précision sur un montant contractuel
      // serait pire que planter.
      throw new Error(`BigInt hors des entiers JSON sûrs : ${value}`);
    }
    return Number(value);
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
  }
  return value;
}
