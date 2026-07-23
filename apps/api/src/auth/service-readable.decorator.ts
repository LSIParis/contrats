import { SetMetadata } from '@nestjs/common';

/**
 * Marque une route comme lisible par une clé d'API de service (header
 * X-Api-Key), EN PLUS de la session. À réserver strictement aux GET en
 * lecture seule : le ScopeGuard n'accepte le chemin clé d'API que si cette
 * métadonnée est présente. C'est le pendant de @Public() pour l'auth de
 * service — explicite et greppable, pour que la surface exposée à la clé
 * reste exactement l'ensemble des routes revues.
 */
export const IS_SERVICE_READABLE_KEY = 'isServiceReadable';
export const ServiceReadable = () => SetMetadata(IS_SERVICE_READABLE_KEY, true);
