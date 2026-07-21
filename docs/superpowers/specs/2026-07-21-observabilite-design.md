# Observabilité applicative — logs structurés, request-id, health profond (increment 1)

**Date** : 2026-07-21
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : rendre la prod **diagnosticable** sans nouvelle infra — logging JSON
structuré (pino), **request-id** corrélé (logs ↔ journal d'audit), endpoint de
**readiness** profond (Postgres + Redis, pour Uptime Kuma), et **filtre
d'exception global**. Pas de Prometheus/Grafana ni de Sentry (increments
ultérieurs).

## 1. Objectif et constat

Le socle observabilité est minimal : `/health` renvoie `{status:'ok'}` **sans
vérifier la base ni Redis**, les logs sont des `console.error` épars non
structurés, **aucun request-id n'est généré** (donc `audit_logs.request_id` est
toujours NULL — l'intercepteur d'audit lit un en-tête que rien ne pose), et les
erreurs non gérées ne sont pas loguées avec contexte.

Cet increment livre le minimum qui rend la prod exploitable, en **stdout** (logs
Docker/Portainer) et via l'**Uptime Kuma déjà en place**.

## 2. Décisions

| Sujet | Décision |
|---|---|
| Logger | **`nestjs-pino`** (JSON structuré vers stdout). Niveau via `LOG_LEVEL` (défaut `info`) ; **`silent` en test** (`NODE_ENV==='test'`, posé par Vitest). |
| Request-id | `genReqId` : réutilise l'en-tête entrant `x-request-id` sinon génère un `uuidv7()` ; le pose en **en-tête de réponse** `x-request-id` et sur `req.id`. |
| Corrélation audit | L'intercepteur d'audit lit `req.id` (repli sur l'en-tête) → `audit_logs.request_id` **enfin renseigné**. Corrélation logs ↔ audit par le même id. |
| Redaction | pino **redacte** `req.headers.cookie` et `req.headers.authorization` (jamais de cookie de session en clair dans les logs). |
| Readiness | `GET /health/ready` (`@Public`) : ping **Postgres** (`SELECT 1`) + **Redis** (`PING`). 200 si tout OK, **503** sinon, corps `{ status, checks:{ db, redis } }`. `GET /health` reste un **liveness** léger (`{status:'ok'}`). |
| Ping DB | Le health controller (dans `apps/api`) **ne peut pas** utiliser `unsafeUnscopedClient` (règle lint §10.3) → helper `pingDatabase()` **dans le package persistence**. |
| Filtre d'exception | Filtre global : logue chaque erreur (5xx=error, 4xx=warn) avec `requestId`/méthode/chemin/statut, et renvoie un corps cohérent `{ statusCode, message, requestId }` — jamais de détail interne sur une 500. |

## 3. API / plateforme

### 3.1 Logging + request-id (`apps/api/src/`)
- `LoggerModule.forRoot(...)` (nestjs-pino) dans `AppModule` : `pinoHttp` avec
  `level` (env/test), `redact`, `genReqId`, `customProps` minimal.
- `main.ts` : `NestFactory.create(AppModule, { rawBody: true, bufferLogs: true })`
  puis `app.useLogger(app.get(Logger))`.
- `AuditInterceptor` : `requestId = req.id ?? req.headers['x-request-id'] ?? null`.

### 3.2 Readiness (`apps/api/src/health/`)
- Sortir `HealthController` de `app.module.ts` vers un petit module dédié
  (`health.controller.ts`), garder `GET /health` (liveness) + ajouter
  `GET /health/ready` (readiness). Injecte `@Inject(REDIS) redis: Redis` et
  appelle `pingDatabase()`.
- `packages/persistence` : `export async function pingDatabase(): Promise<boolean>`
  (`SELECT 1` via `unsafeUnscopedClient`, `true`/`false`).

### 3.3 Filtre d'exception global (`apps/api/src/common/`)
- `AllExceptionsFilter implements ExceptionFilter` (`@Catch()`), enregistré en
  `APP_FILTER`. `HttpException` → statut/message d'origine ; inconnue → 500 +
  message générique. Logue avec le logger (niveau selon statut) + `req.id`.

## 4. Configuration (déploiement)
- `LOG_LEVEL` (optionnel, défaut `info`) ajoutable à l'env de la stack.
- Uptime Kuma : pointer un moniteur HTTP sur `/health/ready` (503 = alerte).
  *(Action ops, hors code.)*

## 5. Sécurité et tests

- **Request-id** : une requête sans en-tête reçoit un `x-request-id` en réponse ;
  un en-tête entrant est conservé ; une mutation auditée a désormais un
  `request_id` **non-null** en base (corrélation).
- **Redaction** : le cookie/authorization n'apparaissent pas dans les logs
  (test : vérifier la config redact ; les logs sont `silent` en test, donc test
  au niveau config/paths).
- **Readiness** : `/health/ready` → 200 `{status:'ok', checks:{db:true,redis:true}}`
  quand tout va ; simuler une panne (Redis/DB) → 503 `degraded`. `/health`
  reste 200 léger.
- **Filtre** : une route qui lève une `HttpException` renvoie le bon statut +
  `{ statusCode, message, requestId }` ; une erreur inconnue → 500 générique
  (pas de fuite de stack) ; l'erreur est loguée.

## 6. Non-objectifs (différés)

- Métriques **Prometheus** (`/metrics`) + **Grafana** (nouvelle stack).
- **Sentry** / suivi d'erreurs externe.
- Tracing distribué (OpenTelemetry).
- Remplacement de **tous** les `console.*` existants par le logger injecté
  (l'increment câble pino + le request-logging + le filtre ; la migration
  exhaustive des logs applicatifs viendra ensuite).
- Expédition des logs vers Loki/agrégateur (stdout suffit au MVP).
