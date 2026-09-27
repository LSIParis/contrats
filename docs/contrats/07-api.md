# 07 — API

> Guide d'intégration des interfaces offertes aux autres applications de la
> suite (brief §8) : API publique `/api/v1` (§1–4, §6), webhooks sortants (§5).

## 1. Principes

- Base : `https://contrats.lsi-maintenance.fr/api/v1`, versionnée dans le chemin. Une rupture de
  contrat ouvrira `/api/v2` ; `/api/v1` n'évolue que par ajouts (champ, route, valeur d'énumération).
- Description **OpenAPI 3.1** générée depuis les schémas Zod qui valident réellement les requêtes
  (`apps/api/src/public-api/schemas.ts` → `openapi.ts`) : servie à `/api/v1/openapi.json`, figée dans
  le dépôt (`openapi.yaml`), documentation navigable à `/api/v1/docs` (rendue côté serveur, sans
  script ni ressource externe). Un test échoue si une route du contrôleur n'est pas décrite, un autre si
  `openapi.yaml` ou le client généré ne sont pas à jour (`pnpm openapi:generate`).
- JSON UTF-8 ; dates calendaires `AAAA-MM-JJ` ; instants ISO 8601 UTC ; montants en **centimes, en
  chaînes** (précision exacte, cf. 04-tarification).
- **Pagination par curseur** : `?limit=` (1–200, défaut 50) et `?cursor=` ; la réponse porte
  `{ data: [...], nextCursor }`, `nextCursor = null` en fin de liste. Le curseur est opaque : le renvoyer
  tel quel, ne jamais le construire.
- **ETag** sur toutes les lectures : renvoyer `If-None-Match: <etag>` → `304 Not Modified` sans corps
  si rien n'a changé.
- **Erreurs RFC 9457** (`application/problem+json`, §6).
- Lecture seule sur les contrats : l'API ne modifie rien, hors abonnements aux webhooks
  (`webhooks:manage`) — les écritures métier restent dans l'application, sous contrôle humain.

## 2. Authentification et scopes

**Clé d'API hachée** (le brief laisse le choix avec OAuth2 *client credentials* ; V2-H33 : une clé
par application de la suite, révocable et tournante, suffit à des échanges serveur à serveur et évite un
serveur d'autorisation de plus).

- Un administrateur (`MSP_ADMIN`) crée un **client d'API** : `POST /v1/admin/api-clients`
  `{name, description?, scopes[], rateLimitPerMinute?}`. La clé `ctr_<prefix>_<secret>` est affichée
  **une seule fois** ; seul le SHA-256 du secret (256 bits aléatoires) est stocké
  (`api_clients.key_hash`). Rotation : `POST /v1/admin/api-clients/:id/rotate` (l'ancienne clé cesse
  immédiatement) ; révocation : `…/revoke`.
- Chaque requête : `Authorization: Bearer ctr_<prefix>_<secret>`. La clé est résolue par son préfixe
  (fonction `app_resolve_api_key`, SECURITY DEFINER, clés actives de tenants actifs), le hachage comparé
  à temps constant.
- Le drapeau **`contrats.api.enabled`** du tenant doit être actif (sinon `403 API_DISABLED`).
- Le client lit **tout le tenant** (pas de portefeuille) ; la RLS reste la barrière entre tenants :
  un identifiant d'un autre tenant répond `404`, comme une ressource inexistante.

| Scope | Donne accès à |
|---|---|
| `contracts:read` | `GET /clients/{clientRef}/contracts`, `GET /contracts/{id}` |
| `contracts:dates:read` | `GET /contracts/{id}/dates`, `GET /deadlines` |
| `pricing:read` | `GET /contracts/{id}/pricing` |
| `pricing:quote` | `POST /pricing/quote` |
| `webhooks:manage` | `GET/POST /webhooks`, `DELETE /webhooks/{id}` |

**Débit** : fenêtre glissante d'une minute par client (`rateLimitPerMinute`, 120 par défaut), en-têtes
`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` ; dépassement → `429` + `Retry-After`
(V2-H32 : compteur en mémoire du processus, une instance d'API par déploiement).

**Journal** : chaque appel est tracé dans `api_call_log` (client, méthode, **motif** de route
`/api/v1/contracts/:id`, statut final, durée, identifiant de requête — jamais de corps ni de paramètre) ;
`api_clients.last_used_at` est mis à jour.

La clé de service historique (`X-Api-Key`, `CONTRACT_SERVICE_API_KEY`, routes `@ServiceReadable` de
`/v1/contracts`) reste en place pour le ticketing ; elle n'ouvre pas `/api/v1`, une session
utilisateur non plus.

## 3. Endpoints

| Méthode | Chemin | Scope | Réponse |
|---|---|---|---|
| `GET` | `/api/v1/clients/{clientRef}/contracts?status=&type=&cursor=&limit=` | `contracts:read` | `ContractPage` |
| `GET` | `/api/v1/contracts/{id}` | `contracts:read` | `Contract` |
| `GET` | `/api/v1/contracts/{id}/dates` | `contracts:dates:read` | `ContractDates` |
| `GET` | `/api/v1/contracts/{id}/pricing?at=&trace=` | `pricing:read` | `Pricing` |
| `POST` | `/api/v1/pricing/quote` | `pricing:quote` | `Quote` |
| `GET` | `/api/v1/deadlines?from=&to=&kind=&cursor=&limit=` | `contracts:dates:read` | `DeadlinePage` |
| `GET` / `POST` | `/api/v1/webhooks` | `webhooks:manage` | abonnements (§5) |
| `DELETE` | `/api/v1/webhooks/{id}` | `webhooks:manage` | abonnement désactivé |

- `clientRef` : UUID du client, **ou** son SIREN (9 chiffres), **ou** sa référence externe (Client Help).
- `status` : liste séparée par des virgules (`ACTIVE,RENEWAL_DUE`).
- `Contract.signatureMode` : mode de la dernière demande de signature (`PDF`, `TEMPLATE`) ou `null`.
- `ContractDates` : `effectiveDate`, `currentPeriodEnd`, `noticeDeadline` (terme − préavis),
  `nextPriceRevision` (prochaine révision du barème), `nextRenewal` (début de la période suivante si le
  contrat se renouvelle et n'est ni résilié ni échu), `renewalMode`, `terminationEffectiveDate`.
- `deadlines` : échéances **ouvertes** entre `from` (défaut aujourd'hui) et `to` (défaut +90 jours,
  fenêtre de 366 jours au plus), triées par date.
- `pricing` et `quote` appellent **le même service** que l'application (même moteur, même trace).

Exemple :

```http
GET /api/v1/contracts/01a0e254-…/dates HTTP/1.1
Authorization: Bearer ctr_k3p9x2m7q1ab_…

HTTP/1.1 200 OK
ETag: "Zk3…"
RateLimit-Remaining: 119

{"contractId":"01a0e254-…","effectiveDate":"2026-01-01","currentPeriodEnd":"2026-12-31",
 "noticeDeadline":"2026-09-30","nextPriceRevision":"2027-01-01","nextRenewal":"2027-01-01",
 "renewalMode":"TACIT","terminationEffectiveDate":null}
```

## 4. Client TypeScript généré

Paquet interne **`@lsi/contrats-client`** (`packages/contrats-client`) : types de tous les schémas et
une méthode par opération, **générés** depuis la même description (`src/generated.ts`), plus un
transport `fetch` écrit à la main (`src/index.ts`) :

```ts
import { ContratsApiError, ContratsClient } from '@lsi/contrats-client';

const api = new ContratsClient({ baseUrl: 'https://contrats.lsi-maintenance.fr', apiKey: process.env.CONTRATS_API_KEY! });
const dates = await api.getContractDates(contractId);
for await (const d of api.paginate((cursor) => api.listDeadlines({ from: '2026-10-01', ...(cursor ? { cursor } : {}) }))) {
  // …
}
try {
  await api.getContract(id);
} catch (e) {
  if (e instanceof ContratsApiError && e.status === 404) {
    // …
  }
}
```

- ETag géré automatiquement (cache mémoire par URL, `If-None-Match`, `304`).
- Erreurs → `ContratsApiError` (`status`, `code`, `problem`, `retryAfterSeconds`).
- La clé est un secret serveur : jamais dans un navigateur.
- Régénération après toute modification de l'API : `pnpm openapi:generate` (vérifié par les tests).
  Publication dans le registre interne de la suite : paquet `private` tant que le registre n'est pas
  désigné (V2-H34).

## 5. Webhooks sortants

### 5.1 Événements

| Type | Émis quand | Producteur |
|---|---|---|
| `contract.signed` | le contrat passe à `SIGNED` | `persistTransition` (webhook DocuSeal) |
| `contract.activated` | le contrat passe à `ACTIVE` | idem (job quotidien à la date de début, validation d'un import) |
| `contract.renewal_due` | le contrat passe à `RENEWAL_DUE` | idem |
| `contract.renewed` | le contrat passe à `RENEWED` | idem |
| `contract.terminated` | le contrat passe à `TERMINATED` | idem (job quotidien à la date d'effet de la résiliation) |
| `pricing.revised` | un barème est révisé | lot 3 (tarification) — schéma publié, producteur à brancher |
| `ping` | bouton « tester » d'un abonnement | administration |

`apps/api/src/contracts/snapshot.ts` → `persistTransition` est l'**unique**
endroit où un statut de contrat est écrit ; la table statut → événement est
`CONTRACT_STATUS_EVENTS` (`apps/api/src/webhooks-out/contract-producers.ts`).
Ajouter un événement : une entrée dans `WEBHOOK_EVENT_SCHEMAS`
(`webhooks-out/events.ts`) et un appel à `OutboundEvents.publish`.

Seules les transitions qui **changent** le statut publient (un statut réécrit
à l'identique ne publie rien).

### 5.2 Corps

```json
{
  "id": "0192a7c1-…",                    // identifiant de l'ÉVÉNEMENT : clé d'idempotence
  "type": "contract.terminated",
  "occurredAt": "2026-09-26T08:00:00.000Z",
  "data": {
    "contract": {
      "id": "0192…", "reference": "CT-2026-0042", "type": "MAIN",
      "status": "TERMINATED", "previousStatus": "TERMINATION_PENDING",
      "customerId": "0192…", "customerExternalRef": "CH-123",
      "startDate": "2026-01-01", "endDate": "2027-01-01",
      "signedAt": "2025-12-15T09:30:00.000Z", "activatedAt": "2026-01-01T00:00:00.000Z",
      "terminatedAt": "2026-09-26T08:00:00.000Z", "terminationEffectiveDate": "2026-09-26"
    }
  }
}
```

- Schémas Zod **exportés** (`ContractEventDataSchema`,
  `PricingRevisedDataSchema`, `PingDataSchema`, `WebhookEnvelopeSchema`) :
  ils entreront tels quels dans l'OpenAPI du lot 7. Règle d'évolution : on
  **ajoute** (champ optionnel, type d'événement), on ne renomme ni ne retire.
  Un consommateur doit ignorer les champs et les statuts qu'il ne connaît pas.
- **Minimisation** : identifiants, références, dates, statuts — jamais de
  nom, e-mail, titre libre, montant ni contenu (08-securite-rgpd.md §2). Les
  schémas sont `.strict()` : un producteur qui ajouterait un champ non prévu
  échoue (en test) au lieu de publier.

### 5.3 En-têtes et signature

| En-tête | Valeur |
|---|---|
| `Content-Type` | `application/json` |
| `X-Contrats-Event` | type de l'événement |
| `X-Contrats-Delivery` | identifiant de la LIVRAISON (stable d'une tentative à l'autre) |
| `X-Contrats-Timestamp` | secondes Unix de la tentative |
| `X-Contrats-Signature` | `v1=<hex HMAC-SHA256(secret, "<timestamp>.<corps brut>")>` |
| `User-Agent` | `LSI-Contrats-Webhooks/1` |

Vérification côté consommateur — **à recopier** (Node ≥ 18, sans dépendance) :

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** rawBody : le corps BRUT reçu (jamais un JSON re-sérialisé). */
export function verifyContratsWebhook(
  secret: string, rawBody: string,
  signatureHeader: string | undefined, timestampHeader: string | undefined,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader || !timestampHeader || !/^\d{1,12}$/.test(timestampHeader)) return false;
  const ts = Number(timestampHeader);
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;      // anti-rejeu ±5 min
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest();
  return signatureHeader.split(',').map((s) => s.trim())
    .filter((s) => s.startsWith('v1=') && /^[0-9a-f]{64}$/i.test(s.slice(3)))
    .some((s) => timingSafeEqual(Buffer.from(s.slice(3), 'hex'), expected)); // temps constant
}
```

- Le timestamp est **dans** le message signé : le rafraîchir invalide la
  signature ; au-delà de ±5 min, refuser (rejeu).
- Comparaison **à temps constant** (`timingSafeEqual`), jamais `===`.
- L'en-tête peut contenir plusieurs signatures séparées par des virgules
  (futur `v2=`, rotation) : une seule valide suffit.
- Implémentation de référence et vecteurs de test :
  `apps/api/src/webhooks-out/signature.ts`, `apps/api/tests/unit/webhooks-out.test.ts`.
- Répondre `2xx` rapidement (< 10 s) et traiter en asynchrone ; dédoublonner
  sur `id` (livraison **au moins une fois**).

### 5.4 Livraison, reprises, désactivation

- **Outbox transactionnelle** : l'événement est écrit dans la transaction de
  la modification métier (`OutboundEvents.publish(tx, …)` →
  `app_publish_webhook_event`) ; il existe si et seulement si la
  modification est validée. Sans abonné actif pour le type, rien n'est écrit.
- Le worker relève l'outbox **chaque minute** (job `webhooks-deliver`) :
  latence normale ≤ ~1 min. Pas d'enfilement « après commit » : la minute
  suffit et évite un second chemin de livraison.
- Délai d'une tentative : **10 s**. Réponse `2xx` = livrée. `3xx` = échec
  (**redirections jamais suivies**). Autre statut ou erreur réseau = échec.
- Reprises après 1 min, 5 min, 30 min, 2 h, 12 h (6 tentatives), puis
  **`DEAD`**. Relivraison manuelle possible (nouvelle série complète).
- Après **N livraisons `DEAD` consécutives** (`WEBHOOKS_DISABLE_AFTER_DEAD`,
  20 par défaut) l'abonnement est **désactivé automatiquement**, avec une
  entrée d'audit `webhook.subscription.auto_disabled` (acteur SYSTEM). Une
  réactivation remet le compteur à zéro.
- Réservation d'une livraison par verrou optimiste : deux workers ne
  l'envoient pas deux fois ; un worker qui meurt en cours d'envoi libère la
  livraison à l'expiration du bail (2 min).

### 5.5 Administration — permission `webhooks.manage` (MSP_ADMIN)

| Méthode | Chemin | Effet |
|---|---|---|
| `GET` | `/v1/admin/webhooks` | abonnements du tenant (+ `eventTypes` disponibles) — **sans secret** |
| `POST` | `/v1/admin/webhooks` | `{ url, description?, eventTypes[] }` → 201 ; **`secret` renvoyé UNE fois** |
| `POST` | `/v1/admin/webhooks/:id/rotate-secret` | nouveau secret, renvoyé une fois ; l'ancien cesse immédiatement |
| `POST` | `/v1/admin/webhooks/:id/disable` · `/enable` | (dés)activation ; `enable` remet le compteur d'échecs à zéro |
| `GET` | `/v1/admin/webhooks/:id/deliveries?status=&limit=` | historique des livraisons (statut, tentative, HTTP, durée, erreur tronquée) |
| `POST` | `/v1/admin/webhooks/:id/test` | envoie un `ping` immédiatement, renvoie `{ deliveryId, outcome }` |
| `POST` | `/v1/admin/webhook-deliveries/:id/redeliver` | relivre immédiatement (nouvelle série de reprises) |

- URL : `https://` obligatoire, sans identifiants ni fragment ; hôtes privés,
  locaux ou réservés refusés — sauf `WEBHOOKS_ALLOW_PRIVATE=true`.
- Un identifiant d'un autre tenant répond **404** (RLS), jamais 403.
- `WebhooksAdminService` ne dépend que du `Scope` : l'API publique (scope
  `webhooks:manage`, lot 7) le réutilisera tel quel.

### 5.6 Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `WEBHOOK_SECRET_KEY` | — (requise en production) | clé AES-256-GCM des secrets d'abonnement (32 octets base64/hex) |
| `WEBHOOK_SECRET_KEY_VERSION` | `1` | numéro de la clé courante |
| `WEBHOOK_SECRET_KEY_V<n>` | — | anciennes clés, le temps d'une rotation |
| `WEBHOOKS_ALLOW_PRIVATE` | `false` | `true` : http et destinations privées permis (tests, dev, réseau privé) |
| `WEBHOOKS_DISABLE_AFTER_DEAD` | `20` | seuil de désactivation automatique |

## 6. Erreurs (RFC 9457)

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json; charset=utf-8

{"type":"https://contrats.lsi-maintenance.fr/api/problems/insufficient-scope","title":"Accès refusé",
 "status":403,"detail":"Scope manquant : contracts:dates:read.","instance":"urn:request:01a0…",
 "code":"INSUFFICIENT_SCOPE","requiredScopes":["contracts:dates:read"]}
```

`code` est stable et sert au traitement automatique ; `detail` est destiné à un humain et peut changer.

| Statut | `code` | Cas |
|---|---|---|
| 400 | `BAD_REQUEST`, `INVALID_CURSOR`, `INVALID_RANGE` | paramètre invalide |
| 401 | `UNAUTHENTICATED`, `INVALID_API_KEY` | clé absente, invalide, révoquée (`WWW-Authenticate: Bearer`) |
| 403 | `INSUFFICIENT_SCOPE`, `API_DISABLED` | scope manquant, API coupée pour le tenant |
| 404 | `NOT_FOUND`, `CONTRACT_NOT_FOUND`, `CLIENT_NOT_FOUND` | inexistant **ou hors du tenant** |
| 409 | codes du moteur de tarification | barème absent, article inconnu… |
| 429 | `RATE_LIMITED` | débit dépassé (`Retry-After`) |
| 5xx | `INTERNAL`, `UNAVAILABLE` | jamais de détail technique |
