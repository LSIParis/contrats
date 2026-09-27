# 08 — Sécurité, conformité RGPD et preuve

> Brief §10. Plan du document — les sections sans contenu seront rédigées
> par les lots concernés ; **la section 3 (webhooks sortants) est livrée**
> (lot 5).

## 1. Secrets applicatifs

Tous les secrets sont fournis par l'environnement du conteneur (variables de
la stack Portainer, jamais commitées : `deploy/portainer/stack.env.example`).
Aucun secret n'est stocké en clair en base.

| Secret | Où | Rotation |
|---|---|---|
| Clé d'API / HMAC DocuSeal | env (`DOCUSEAL_*`) | 06-docuseal.md |
| Clés IA (Perplexity, Claude) | env | 05-ia-perplexity.md |
| Secrets HMAC des webhooks sortants | base, **chiffrés** par `WEBHOOK_SECRET_KEY` (env) | §3.2 |
| Clés d'API des clients de l'API publique | base, **hachées** | lot 7 (07-api.md §2) |

## 2. Minimisation des données transmises

- IA : texte pseudonymisé uniquement, désactivable par tenant (05-ia-perplexity.md).
- Webhooks sortants : §3.1.

## 3. Webhooks sortants

### 3.1 Charges utiles minimisées

Un webhook part vers un système tiers (ERP, outil de la suite) : ce qui y
figure sort du périmètre de l'application. Les charges utiles ne portent donc
que des **identifiants, références, dates et statuts** :

- contrat : `id`, `reference`, `type`, `status`, `previousStatus`, dates
  (début, fin, signature, activation, résiliation, date d'effet) ;
- client : `customerId` et `customerExternalRef` (référence Client Help) —
  **jamais** sa raison sociale, ses contacts ni ses signataires ;
- pas de titre de contrat (texte libre pouvant nommer une personne), pas de
  montant, pas de contenu contractuel, pas de commentaire.

Garanties : schémas Zod `.strict()` validés **avant** l'écriture dans
l'outbox (`apps/api/src/webhooks-out/events.ts`) ; test qui vérifie qu'un
titre nominatif et un montant présents sur la ligne ne sortent pas
(`tests/isolation/webhooks-out.test.ts`). Sans abonné actif pour un type,
aucun événement n'est conservé. Le consommateur qui a besoin de plus relit
l'API publique avec ses propres droits (scopes), ce qui laisse une trace.

`webhook_events.customer_id` permettra à la purge RGPD d'un client (lot à
venir) d'effacer ses événements : la table n'a volontairement pas de FK vers
`customers`, pour ne pas bloquer cette purge.

### 3.2 Secret HMAC : chiffrement et rotation

- Le secret d'un abonnement (`whsec_…`, 256 bits aléatoires) doit être relu
  pour signer chaque livraison : il est **chiffré** (AES-256-GCM, IV aléatoire
  de 96 bits, AAD = identifiant d'abonnement + version de clé), jamais haché.
  Une fuite de la base seule ne livre aucun secret ; un chiffré recollé sur un
  autre abonnement ne se déchiffre pas.
- Il n'est **montré qu'une fois** (réponse de création ou de rotation), jamais
  relu par l'API ensuite ; seuls ses 4 derniers caractères (`secretHint`) sont
  affichés pour l'identifier. Le journal d'audit enregistre le corps des
  requêtes (sans secret : il est généré côté serveur), jamais les réponses.
- **Rotation du secret d'un abonnement** : `POST /v1/admin/webhooks/:id/rotate-secret`.
  L'ancien secret cesse immédiatement : le consommateur doit être mis à jour
  dans la foulée (les livraisons en échec entre-temps sont reprises
  automatiquement, puis relivrables à la main).
- **Rotation de la clé maîtresse `WEBHOOK_SECRET_KEY`** (compromission
  supposée, départ d'un administrateur, rythme annuel) :
  1. `openssl rand -base64 32` → nouvelle clé ;
  2. l'ancienne clé passe dans `WEBHOOK_SECRET_KEY_V<n>` (n = valeur actuelle
     de `WEBHOOK_SECRET_KEY_VERSION`), la nouvelle dans `WEBHOOK_SECRET_KEY`,
     `WEBHOOK_SECRET_KEY_VERSION` = n+1 ; redéployer `app` **et** `worker` ;
  3. les secrets existants restent lisibles (colonne `secret_key_version`) ;
     faire tourner le secret de chaque abonnement pour les rechiffrer avec la
     nouvelle clé (ou attendre leur rotation naturelle) ;
  4. quand plus aucune ligne n'utilise la version n
     (`SELECT count(*) FROM webhook_subscriptions WHERE secret_key_version = n`),
     retirer `WEBHOOK_SECRET_KEY_V<n>`.
- Perte de la clé maîtresse : les secrets sont indéchiffrables, les
  livraisons échouent ; faire tourner le secret de chaque abonnement.

### 3.3 SSRF

L'URL est saisie par un admin, mais c'est le serveur qui l'appelle :

- `https://` obligatoire ; ni identifiants ni fragment dans l'URL ;
- hôtes locaux (`localhost`, `*.local`, `*.internal`, nom sans point) et IP
  privées, de boucle, lien-local (dont `169.254.169.254`), CGNAT, réservées ou
  multicast refusés **à l'enregistrement** ;
- **à la connexion**, le nom est résolu et **chaque** adresse vérifiée avant
  l'ouverture de la socket (anti-rebinding DNS) ; une IP littérale est vérifiée
  sans résolution ;
- **redirections jamais suivies** (une `3xx` est un échec) ;
- délai de 10 s, lecture de la réponse limitée à 1 Ko, pas de connexion
  réutilisée d'un abonné à l'autre.

`WEBHOOKS_ALLOW_PRIVATE=true` lève ces barrières : réservé aux tests, au
poste de développement ou à un consommateur délibérément placé sur le réseau
privé — c'est un choix d'exploitation à consigner.

### 3.4 Cloisonnement et journalisation

- Tables de classe tenant, RLS `ENABLE` + `FORCE`, aucun accès CLIENT ; un
  commercial ne lit que les événements de son portefeuille. Publication
  depuis n'importe quel scope par une fonction `SECURITY DEFINER` bornée au
  tenant et au scope courants ; outbox append-only.
- Les journaux ne contiennent ni secret ni corps : identifiants de livraison,
  type, statut HTTP, durée. `last_error` est tronqué à 500 caractères.
- La désactivation automatique d'un abonnement est tracée dans le journal
  d'audit chaîné (`webhook.subscription.auto_disabled`) ; les actions
  d'administration le sont par l'intercepteur d'audit.

### 3.5 API publique (lot 7)

- Clés d'API `ctr_<prefix>_<secret>` : secret de 256 bits, **seul son SHA-256 est stocké**
  (`api_clients.key_hash`) ; affichée une fois, rotation et révocation immédiates ; comparaison à temps
  constant. Aucune clé n'est journalisée (le journal applicatif ne contient pas l'en-tête
  `Authorization`).
- Résolution d'une clé avant tout scope par une fonction SECURITY DEFINER bornée à un préfixe exact
  (clés actives, tenants actifs) ; ensuite la RLS du tenant s'applique comme pour une session.
- `api_call_log` : méthode, motif de route, statut, durée, identifiant de requête, **sans corps ni
  paramètre** (donc sans donnée personnelle) ; table append-only (`UPDATE`/`DELETE` révoqués).
  Conservation proposée : 12 mois (hypothèse, à confirmer avec le registre des traitements).
- `ai_usage` (lot 6) : jetons, coût, durée, statut par appel IA — aucun texte.

## 4. Stockage des documents et preuve

## 5. Journal d'audit

## 6. Registre des traitements, conservation, purge, export
