# 07 — API

> Spécification des interfaces offertes aux autres applications de la suite
> (brief §8). Plan du document — les sections marquées *(lot 7)* seront
> rédigées avec l'API publique ; **la section 5 (webhooks sortants) est
> livrée** (lot 5).

## 1. Principes *(lot 7)*

- `/api/v1`, versionnée ; description OpenAPI 3.1 générée depuis les schémas
  Zod (`z.toJSONSchema()`), servie à `/api/v1/openapi.json`, documentation
  navigable auto-hébergée `/api/v1/docs`.
- Pagination par curseur, `ETag` / `If-None-Match`, erreurs RFC 9457
  (`application/problem+json`).

## 2. Authentification et scopes *(lot 7)*

`ApiClient` par application consommatrice, clé d'API hachée en base
(`ctr_<prefix>_<secret>`, V2-H8). Scopes : `contracts:read`,
`contracts:dates:read`, `pricing:read`, `pricing:quote`, `webhooks:manage`.

## 3. Endpoints de lecture *(lot 7)*

## 4. Client TypeScript généré *(lot 7)*

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

## 6. Propositions commerciales (lot 9)

> API **interne** (session, UI) et **page publique** (jeton). L'exposition
> dans l'API publique `/api/v1` (`GET /proposals`, `/proposals/{id}`,
> `/proposals/{id}/pricing`, `/clients/{clientRef}/proposals`, scopes
> `proposals:read`, `proposals:pricing:read`), l'OpenAPI et le client régénérés
> relèvent du **lot 9.8**. Toutes les entrées sont validées par Zod
> (`apps/api/src/proposals/proposals.schemas.ts`, `.strict()`).

### 6.1 API interne `/v1/proposals` (droits : `permissions.ts`, `proposals.*`)

| Méthode | Chemin | Action |
|---|---|---|
| GET | `/v1/proposals?status=&customerId=&mine=&limit=` | liste (portefeuille) |
| POST | `/v1/proposals` | création (`customerId`, `templateSlug?`, `title?`, `acceptanceMode?`, `mergeContext?`, `contactIds?`) |
| GET | `/v1/proposals/stream` | notifications temps réel (SSE) du commercial |
| GET / PATCH | `/v1/proposals/:id` | détail (version, sections, tableau de prix, devis du moteur, préparation, transitions possibles) / métadonnées |
| PUT | `/v1/proposals/:id/sections` | sections et blocs (brouillon) |
| PUT | `/v1/proposals/:id/pricing` | tableau de prix (brouillon ; prix modifié → `TO_VALIDATE`) |
| POST | `/v1/proposals/:id/pricing/validate` | valider un prix de la proposition (admin) |
| PUT | `/v1/proposals/:id/selection` | configuration proposée (brouillon, prête) |
| POST / DELETE | `/v1/proposals/:id/recipients[/:recipientId]` | destinataires |
| GET | `/v1/proposals/:id/readiness` | contrôles de préparation détaillés |
| POST | `/v1/proposals/:id/import-docx` | import Word (multipart `file`) |
| POST | `…/submit-review`, `…/approve-review`, `…/reject-review`, `…/mark-ready`, `…/send`, `…/resend`, `…/revise`, `…/withdraw`, `…/reactivate`, `…/close-discussion` | transitions (sous-ressources d'action) |
| POST | `/v1/proposals/:id/sections/:key/validate` | valider une section « à valider » (admin) |
| POST | `/v1/proposals/:id/start-signature`, `/v1/proposals/:id/convert` | relances manuelles (signature, conversion) |
| GET | `/v1/proposals/:id/tracking`, `…/comments`, `…/pdf`, `…/preview` | suivi, échanges, PDF de la version, aperçu HTML |
| POST | `/v1/proposals/:id/comments` | réponse du commercial |

Administration `/v1/proposal-admin` : `GET templates[/:slug]`,
`PATCH templates/:slug`, `PATCH templates/:slug/lines/:key`,
`GET pending-validations`, `POST pending-validations/validate`,
`GET|POST library`, `PATCH library/:key`, `GET|POST terms`,
`PUT contract-templates/:id/slug`.

Erreurs : 404 hors portefeuille (jamais 403 sur une ressource), 404
`PROPOSALS_DISABLED` module désactivé, 409 `PROPOSAL_INVALID_TRANSITION`
(avec `allowedTransitions`) / `PROPOSAL_RULE_VIOLATION` (avec `rule` :
`P-TO-VALIDATE`, `P-MERGE-TAGS`, `P-REVIEW-REQUIRED`, `P-SUPERSEDED`,
`P-EXPIRED`…), 422 `PROPOSAL_REQUIRED` (création directe de contrat).

### 6.2 Page publique `/v1/public/proposals/:token` (`@Public`)

`GET` (consultation), `POST /events` (suivi groupé), `PUT /selection`
(configuration), `POST /comments`, `POST /decline`, `POST /otp`,
`POST /otp/verify`, `POST /accept`, `GET /pdf`. En-tête `x-proposal-otp` pour
une session de code vérifié. Réponses `noindex`, `no-store`, `no-referrer` ;
404 lien inconnu, 410 `LINK_REVOKED` / `LINK_EXPIRED`, 429 `RATE_LIMITED`.
Détail : `11-propositions.md` §6.

### 6.3 Webhooks sortants `proposal.*`

| Type | Émis quand |
|---|---|
| `proposal.sent` | la proposition passe `SENT` (envoi, renvoi après réactivation) |
| `proposal.viewed` | première consultation (`VIEWED`) |
| `proposal.accepted` | acceptation (`ACCEPTED`) |
| `proposal.signed` | signature (DocuSeal complétée et preuves archivées, ou acceptation par clic) |
| `proposal.declined` | refus du client (motif **codé** seulement) |
| `proposal.expired` | échéance passée (`EXPIRED`) |
| `proposal.converted` | contrat généré (`CONVERTED`, `contractId`) |

Producteur unique : `persistProposalTransition`
(`apps/api/src/proposals/proposal-transition.ts`), dans la transaction de la
transition (outbox). Charge utile minimisée (`ProposalRefSchema`,
`webhooks-out/events.ts`) : identifiants, numéro, statuts, version, échéance,
motif de refus codé, contrat — ni montant, ni titre, ni contact.
