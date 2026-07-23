# Spec — Contrat · API-key de service (lecture des contrats en serveur-à-serveur)

**Date :** 2026-07-23
**Repo :** `lsi-contrats` (`D:\code\contrats`)
**Branche :** `feat/service-api-key`
**Statut :** Validé (design approuvé) — prêt pour plan d'implémentation
**Contexte externe :** débloque la tranche « Couplage Contrat » de la plateforme de ticketing (`D:\code\ticket`), qui doit lire la liste des contrats sans session Microsoft 365.

---

## 1. Objectif

Aujourd'hui, l'auth de Contrat est **exclusivement par cookie de session** (SSO Microsoft 365), via le `ScopeGuard` global. Un back-end externe (la plateforme de ticketing) ne peut donc pas appeler l'API en serveur-à-serveur.

Cette tranche ajoute une **authentification par clé d'API de service** (`X-Api-Key`) permettant à un appelant machine de **lire les contrats** (`GET /v1/contracts`, `GET /v1/contracts/:id`) — et **rien d'autre** —, sans toucher au flux de session existant ni à la surface des routes publiques.

### Critère de succès
- Une requête `GET /v1/contracts` avec un header `X-Api-Key` valide et **sans cookie** réussit et renvoie tous les contrats du tenant (scope `allCustomers`).
- Une clé absente/invalide → **401**.
- La clé ne donne accès **qu'aux routes marquées `@ServiceReadable()`** (list + findOne des contrats) ; elle ne fonctionne sur **aucune route mutante** ni sur les autres endpoints.
- Le flux de session M365 existant est **inchangé** ; le test structurel gelant les routes `@Public()` **n'est pas modifié**.
- Des **données de contrat de démo** existent dans l'instance (customer + ≥ 2 contrats) pour permettre le test d'import de bout en bout côté ticketing.

---

## 2. Contexte technique (état actuel, vérifié)

- Pas de `setGlobalPrefix` : le préfixe `/v1` est dans chaque `@Controller('v1/...')`.
- **`ScopeGuard`** (`apps/api/src/auth/scope.guard.ts`) est enregistré en `APP_GUARD` global (`app.module.ts`) et s'exécute avant `ClientPortalGuard`. Il lit le cookie de session (`__Host-lsi_sess` en prod / `lsi_sess` en dev), résout la session en Redis (`SessionService`), pose `req.session` (type `Scope`).
- **`@Public()`** (`apps/api/src/auth/public.decorator.ts`, clé `IS_PUBLIC_KEY`) est le seul contournement du `ScopeGuard`, et la **liste exacte des routes publiques est gelée** par `tests/structural/scope-surface.test.ts` (échoue exprès si on ajoute une route publique). → **On ne passe pas par `@Public()`.**
- **`GET /v1/contracts`** → `ContractsController.list` (`contracts.controller.ts:61`) → `ContractsService.list(scope, dto)` dans `withScope()` (RLS Postgres). Renvoie `{ data: Contract[], pagination: { nextCursor: string|null, hasMore: boolean } }`. `GET /v1/contracts/:id` → `findOne` (`:66`).
- **`Scope`** (`packages/persistence/src/scope.ts`) : `{ tenantId, customerIds, allCustomers, userId, actorKind }`. Constructeur `adminScope(tenantId, userId='system')` → `allCustomers: true` (voit tous les customers du tenant), `actorKind: 'INTERNAL'`.
- **Config** : lecture directe `process.env.X` (pas de `ConfigService`) ; secrets prod injectés via AWS Secrets Manager, jamais dans l'image. Précédent de comparaison **timing-safe** : `docuseal.adapter.ts` (`crypto.timingSafeEqual`, throw si secret d'env absent).
- **`ValidationPipe`** global `whitelist:true, forbidNonWhitelisted:true`.

---

## 3. Conception

### 3.1 Marqueur `@ServiceReadable()`
Nouveau décorateur (`apps/api/src/auth/service-readable.decorator.ts`), même patron que `@Public()` :
```ts
export const IS_SERVICE_READABLE_KEY = 'isServiceReadable';
export const ServiceReadable = () => SetMetadata(IS_SERVICE_READABLE_KEY, true);
```
Posé **uniquement** sur `ContractsController.list` et `ContractsController.findOne`. Le guard n'accepte le chemin API-key que si la route porte ce marqueur → surface d'attaque de la clé bornée à ces deux GET, explicite et greppable (comme `@Public()`).

### 3.2 Extension de `ScopeGuard`
Dans `canActivate`, **avant** de lever `UnauthorizedException('Session absente')** quand il n'y a pas de cookie de session :
1. Lire le header `X-Api-Key` (`req.headers['x-api-key']`).
2. Si présent :
   - La route doit être `@ServiceReadable()` (métadonnée via `Reflector.getAllAndOverride(IS_SERVICE_READABLE_KEY, ...)`) ; sinon → 401 (`Clé API non autorisée sur cette route`).
   - Comparer la clé, en **timing-safe** (helper à la `docuseal.adapter` : contrôle de longueur puis `crypto.timingSafeEqual`), à `process.env.CONTRACT_SERVICE_API_KEY`.
     - Si l'env est **absent** : en production, **throw au démarrage/handler** (mirroir de `DOCUSEAL_WEBHOOK_SECRET`) — la clé ne doit jamais « marcher par défaut ».
     - Si la clé ne correspond pas → 401 (`Clé API invalide`).
   - Si valide : `req.session = buildServiceSession()` puis `return true`.
3. Sinon (pas de clé) : comportement inchangé (chemin cookie de session).

Le cookie de session reste prioritaire : si un cookie valide est présent, on n'entre pas dans la branche API-key.

### 3.3 Session de service
`buildServiceSession()` construit un `Scope` de service :
```ts
adminScope(tenantSlugResolvedId, 'service:ticketing')
```
- `tenantSlugResolvedId` = tenant résolu via `findTenantBySlug(process.env.DEFAULT_TENANT_SLUG ?? 'lsi')` (même mécanisme que les deux contrôleurs de login existants).
- `allCustomers: true` (lecture de tous les contrats du tenant), `actorKind: 'INTERNAL'` (réutilise un actorKind déjà supporté par la RLS — **pas de nouveau kind**, pas de changement de politique RLS), `userId: 'service:ticketing'` (distinguable en audit).
- Read-only garanti par : (a) `@ServiceReadable()` posé uniquement sur des GET, (b) le guard n'accepte la clé que sur ces routes.

### 3.4 Configuration
`.env.example` : nouvelle section
```
# --- API de service (ticketing externe) ---------------------------------
# Clé d'auth serveur-à-serveur (header X-Api-Key) pour la lecture des contrats.
# Absente en dev par défaut ; générée et injectée via Secrets Manager en prod.
CONTRACT_SERVICE_API_KEY=""
```

### 3.5 Données de démo (pour le test d'intégration ticketing)
L'instance étant neuve (aucun contrat), fournir un **customer de démo + ≥ 2 contrats** exploitables par l'import du ticketing. Le **mécanisme** suit la convention de chargement de données du repo (script sous `scripts/` ou seed Prisma — déterminé au plan après repérage). Les contrats de démo couvrent des statuts variés (ex. `ACTIVE`, `SIGNED`) pour tester le mapping de statut côté ticketing.

---

## 4. Sécurité

- Comparaison **timing-safe** de la clé (pas de `===`).
- Clé **jamais** valide par défaut : throw en prod si `CONTRACT_SERVICE_API_KEY` absent.
- Surface bornée : la clé n'ouvre que les routes `@ServiceReadable()` (2 GET contrats), jamais les mutations, jamais les autres ressources.
- Le scope de service passe par la **RLS existante** (`withScope`) : aucune fuite inter-tenant ; `allCustomers` reste borné au tenant résolu.
- Aucun assouplissement de CORS (`credentials:true` + origine fermée) — non pertinent pour un appel serveur-à-serveur.
- Le test structurel des routes `@Public()` reste **intact** (on n'ajoute aucune route publique).

---

## 5. Tests

- **`tests/isolation/api-key-guard.test.ts`** (style des tests d'isolation existants) :
  - clé valide + **pas de cookie** sur `GET /v1/contracts` → 200, scope `allCustomers:true` (voit les contrats de tous les customers du tenant).
  - clé **invalide** → 401 ; clé **absente** (ni cookie ni clé) → 401 « Session absente ».
  - clé valide sur une route **non `@ServiceReadable`** (ex. une route mutante ou un autre GET non marqué) → 401.
  - (si faisable) `CONTRACT_SERVICE_API_KEY` non défini → la branche API-key throw (ne « réussit » jamais).
- Le test structurel `scope-surface.test.ts` doit rester **vert sans modification** (preuve que la surface publique n'a pas bougé).
- `lint` + `typecheck` verts.

---

## 6. Déploiement

1. Générer une **clé forte** (`CONTRACT_SERVICE_API_KEY`) — la même valeur sera renseignée côté ticketing (variable d'env de sa stack).
2. Merger → la CI de `lsi-contrats` publie l'image.
3. Portainer (Docker Legal) : sur la stack `lsi-contrats`, ajouter la variable d'env `CONTRACT_SERVICE_API_KEY` puis **Pull & redeploy**.
4. Vérifier : `GET /v1/contracts` avec `X-Api-Key` correct → 200 ; sans/avec mauvaise clé → 401.

---

## 7. Hors périmètre

- Aucune modification de l'auth session / M365.
- Aucune capacité **mutante** via la clé (création/édition de contrats reste réservée à la session).
- Pas d'exposition d'autres ressources (customers, templates, signatures…) via la clé — uniquement la lecture des contrats.
- Rotation/gestion multi-clés, scoping de la clé à des customers précis : évolutions ultérieures (le `Scope` le permettra sans changer les contrôleurs).
- Toute la logique **côté ticketing** (import, paramétrage, SLA par contrat) : sous-projet B, repo `D:\code\ticket`.
