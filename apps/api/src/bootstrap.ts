import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { uuidv7 } from '@lsi/persistence';

/**
 * Configuration HTTP PARTAGÉE entre `main.ts` et les tests.
 *
 * Avant la bascule Fastify, chaque test recomposait sa propre application
 * (`createNestApplication()` + un `ValidationPipe` plus ou moins fidèle) : les
 * tests validaient une configuration qui n'était pas celle de production. Un
 * seul point d'assemblage supprime cette divergence — si la prod refuse un
 * champ inconnu, les tests le refusent aussi.
 */

/** Taille maximale d'un upload (scans PDF). Alignée sur `client_max_body_size` du proxy. */
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);

/**
 * Préfixes qui ne doivent JAMAIS tomber sur le repli SPA.
 *
 * Le bug historique (cf. serve-static.test.ts) : une route API inconnue
 * renvoyait `200 index.html`, ce qui transformait une faute de frappe côté
 * client en « succès » silencieux. Le chargeur Fastify de
 * `@nestjs/serve-static` IGNORE l'option `exclude` : on ne s'en sert donc
 * plus, le repli est assemblé ici, explicitement.
 */
const API_PREFIXES = ['/v1', '/api', '/health', '/healthz', '/readyz'];

export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    // Derrière le reverse proxy : `req.ip` doit être l'IP du client (audit,
    // limitation de débit), pas celle du proxy. Ne JAMAIS l'activer sans
    // proxy devant : n'importe qui pourrait forger X-Forwarded-For.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    bodyLimit: MAX_UPLOAD_BYTES,
    // UNE seule source d'identifiant de requête : celle-ci. Elle est reprise
    // par pino-http (logs), le filtre d'exception (corps d'erreur), l'audit
    // (request_id) et renvoyée au client (en-tête x-request-id).
    requestIdHeader: false,
    genReqId: requestIdFor,
  });
}

/**
 * Reprend le `x-request-id` entrant (corrélation avec l'appelant) s'il est
 * raisonnable, sinon en génère un. Un en-tête libre recopié tel quel dans les
 * logs serait un vecteur d'injection de lignes : on borne longueur et alphabet.
 *
 * L'id est aussi posé sur la requête Node brute, que pino-http reçoit (via
 * middie) sans connaître l'objet requête Fastify.
 */
export function requestIdFor(raw: IncomingMessage): string {
  const incoming = raw.headers['x-request-id'];
  const id = typeof incoming === 'string' && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : uuidv7();
  (raw as IncomingMessage & { id?: string }).id = id;
  return id;
}

function parseTrustProxy(v: string | undefined): boolean | number | string {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // liste d'IP / CIDR
}

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  // Cookie de session (§13.1). Aucun secret : le cookie n'est pas signé, sa
  // valeur est un identifiant opaque résolu côté serveur (Redis).
  await app.register(fastifyCookie as never);

  // Uploads (import de scans). Une seule pièce par requête, taille bornée :
  // au-delà, 413 AVANT d'avoir tout lu en mémoire.
  await app.register(fastifyMultipart as never, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 30 },
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Un champ inconnu FAIT ÉCHOUER la requête au lieu d'être ignoré.
      //
      // Sans cela, un `tenantId` envoyé par un appelant serait retiré en
      // silence — et le jour où quelqu'un lit `req.body` brut quelque part,
      // il serait là. On échoue bruyamment plutôt que d'ignorer discrètement.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Même origine en production (SPA servie par l'API) : CORS fermé par défaut.
  app.enableCors({ origin: process.env.APP_ORIGIN ?? false, credentials: true });

  // Sert le bundle Vite. Résolu depuis `import.meta.url` (emplacement RÉEL de
  // ce fichier), JAMAIS depuis `process.cwd()` : `pnpm --filter <pkg> exec`
  // lance le process avec cwd = dossier du package (cf. Dockerfile).
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webDist)) {
    await app.register(fastifyStatic as never, { root: webDist, wildcard: false, index: false });
    fastify.get('/*', (req, reply) => {
      const path = req.url.split('?')[0] ?? '/';
      if (API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
        // Même forme que les 404 de Nest (AllExceptionsFilter).
        void reply.code(404).type('application/json').send({
          statusCode: 404,
          message: `Cannot GET ${path}`,
          error: 'Not Found',
          requestId: req.id ?? null,
        });
        return;
      }
      void reply.type('text/html').sendFile('index.html');
    });
  }
}
