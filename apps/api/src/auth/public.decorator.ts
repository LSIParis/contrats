import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'lsi:isPublic';

/**
 * Désactive le guard de scope sur une route.
 *
 * LA SEULE échappatoire au cloisonnement côté HTTP. Elle est :
 *   - explicite (impossible par oubli)
 *   - cherchable (`grep -r "@Public"` liste toute la surface non gardée)
 *   - figée par un test (tests/structural/scope-surface.test.ts)
 *
 * C'est toute la différence entre « sécurisé si on n'oublie pas » et
 * « sécurisé sauf si on désactive délibérément ». Pour une contrainte non
 * négociable, seule la seconde posture est tenable.
 *
 * Usages légitimes : le webhook DocuSeal (pas de session — le scope est
 * résolu en base, §11.4) et le healthcheck.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
