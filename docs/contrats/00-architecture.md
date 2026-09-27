# 00 — Architecture de l'application « Contrats »

> Spécification de référence de la passe « brief v2 » (septembre 2026).
> Les dossiers `docs/superpowers/specs/*` restent l'historique de conception
> des phases A–E ; ce dossier `docs/contrats/` est la spécification courante.
> En cas de divergence, **ce dossier fait foi**.

## 1. Point de départ

Le dépôt `LSIParis/contrats` n'est pas vierge : 234 commits, une application
en production partielle. La décision (validée par le propriétaire le
2026-09-26) est **d'étendre l'existant**, pas de le réécrire :

| Existant conservé | Complété par la passe v2 |
|---|---|
| Monorepo pnpm : `apps/api` (NestJS 10), `apps/web` (React 18 + Vite + TanStack Query + TipTap + Tailwind), `packages/domain`, `packages/persistence` (Prisma 5) | Adaptateur HTTP **Fastify** (`@nestjs/platform-fastify`) à la place d'Express |
| Isolation tenant → **client** par RLS PostgreSQL + FK composites + `withScope()` | Même modèle, étendu à toutes les nouvelles tables |
| Machine à états pure (`packages/domain`) | États du brief ajoutés (§3) |
| Journal d'audit chaîné par hash, append-only (révoqué au niveau SGBD) | Inchangé |
| DocuSeal (adaptateur, webhooks HMAC, idempotence, preuves, réconciliation) | Voie Pro `/submissions/pdf` + balises textuelles, readiness |
| Rédaction IA (port `ContractDrafter`, adaptateur Claude) | Adaptateur **Perplexity Agent API** (défaut), Claude conservé, choix par tenant |
| Import d'existant (dépôt PDF, SHA-256) | OCR, extraction, écran de validation, état `IMPORTED_PENDING_VALIDATION` |
| Stack Portainer + image GHCR | Workflows de l'annexe A, version épinglée, tunnel SSH, `/healthz` |
| — | **Tarification** (nouveau paquet `packages/pricing`) |
| — | **API publique `/api/v1`** (Zod → OpenAPI 3.1, `ApiClient`, scopes, webhooks sortants, client TS généré) |
| — | Feature flags par tenant, `Deadline`, charte lticket |

## 2. Composants

```
                    reverse proxy existant (openresty / NPM) — HTTPS, HSTS
                                     │
                     ┌───────────────▼────────────────┐
                     │ app  (image ghcr.io/…/contrats)│  Fastify via NestJS
                     │  /v1/*       API interne (UI)  │  sessions cookie (SSO M365, lien magique)
                     │  /api/v1/*   API publique      │  ApiClient + scopes
                     │  /healthz /readyz              │
                     │  SPA React (fichiers statiques)│
                     └──┬─────────┬─────────┬─────────┘
                        │ BullMQ  │         │
                ┌───────▼──┐  ┌───▼───┐  ┌──▼────────┐   ┌───────────┐
                │  worker  │  │ redis │  │ postgres  │   │  minio    │ S3 auto-hébergé
                │ (même    │  └───────┘  │ 17 + RLS  │   │ versioning│ (originaux write-once)
                │  image)  │             └───────────┘   └───────────┘
                └─┬───┬───┬┘
                  │   │   └──────────► ocr (ocrmypdf + tesseract fra, HTTP interne)
                  │   └──────────────► gotenberg (HTML → PDF, JS désactivé, IP privées refusées)
                  ├──────────────────► DocuSeal Pro (VPS dédié, API X-Auth-Token)
                  └──────────────────► Perplexity Agent API (texte pseudonymisé uniquement)
```

- **Une seule image** pour `app`, `worker` et `migrate` ; la commande diffère
  (`src/main.ts`, `src/worker.ts`, `deploy/migrate.sh`).
- Le `worker` est un contexte applicatif NestJS **sans serveur HTTP** : il
  consomme BullMQ et porte les tâches planifiées (échéancier quotidien,
  réconciliation DocuSeal, OCR, livraison des webhooks sortants, purge RGPD).

## 3. Correspondance brief ↔ modèle

### 3.1 Statuts (codes anglais en base, libellés français à l'écran)

| Brief | Code | Nouveau ? |
|---|---|---|
| BROUILLON | `DRAFT` | — |
| EN_REVUE_INTERNE | `IN_REVIEW` (+ `CHANGES_REQUESTED` pour le retour du valideur) | — |
| ENVOYÉ_AU_CLIENT | `SENT_TO_CLIENT` | oui |
| EN_NÉGOCIATION | `IN_NEGOTIATION` | oui |
| ACCEPTÉ | `ACCEPTED` | oui |
| (validation interne) | `APPROVED` | — |
| EN_SIGNATURE | `PENDING_SIGNATURE`, `PARTIALLY_SIGNED` | — |
| SIGNÉ | `SIGNED` | — |
| ACTIF | `ACTIVE` | — |
| À_RENOUVELER | `RENEWAL_DUE` | oui |
| RENOUVELÉ | `RENEWED` | — |
| EN_RÉSILIATION | `TERMINATION_PENDING` | oui |
| RÉSILIÉ | `TERMINATED` | — |
| EXPIRÉ | `EXPIRED` | — |
| ANNULÉ | `CANCELLED` | — |
| REFUSÉ | `DECLINED` (n'est plus terminal : retour en négociation) | modifié |
| SIGNATURE_EXPIRÉE | `SIGNATURE_EXPIRED` | oui |
| IMPORTÉ_À_VALIDER | `IMPORTED_PENDING_VALIDATION` | oui |

Détail des transitions : `02-cycle-de-vie.md`.

### 3.2 Origine et mode de signature

| Brief | Base (`ContractOrigin`) | API publique |
|---|---|---|
| `TEMPLATE` | `NATIVE` (historique) | `TEMPLATE` |
| `AI` | `AI` (ajouté) | `AI` |
| `LEGACY_IMPORT` | `IMPORTED` (historique) | `LEGACY_IMPORT` |

`signatureMode` est **dérivé** : `EXTERNAL_WET_SIGNATURE` si l'origine est un
import, `ELECTRONIC_DOCUSEAL` sinon. Pas de colonne : une valeur dérivée ne
peut pas contredire sa source.

### 3.3 Rôles

| Brief | `RoleCode` | Portée |
|---|---|---|
| `admin` | `MSP_ADMIN` | tous clients |
| `commercial` | `ACCOUNT_MANAGER` | portefeuille (`customer_access`) |
| `juriste` / `valideur` | `LEGAL_REVIEWER` | tous clients |
| `signataire_interne` | `INTERNAL_SIGNATORY` (ajouté) | tous clients, lecture + signature |
| `lecteur` | `READER` (ajouté) ; `TECHNICIAN` historique conservé | portefeuille |
| `client` | `CLIENT_SIGNER`, `CLIENT_VIEWER` | son seul client (portail) |

La matrice rôle × action est codée dans `apps/api/src/auth/permissions.ts` et
testée exhaustivement (`tests/isolation/permissions-matrix.test.ts`).

### 3.4 Entités du brief

| Brief | Réalisation |
|---|---|
| `Tenant`, `Client`, `ClientContact` | `Tenant`, `Customer`, `CustomerContact` (+ `externalRef`, `isConsumer`, `signingCapacity`) |
| `ContractTemplate`, `Clause`/`ClauseLibraryItem` | `ContractTemplate(+Version)`, `ClauseLibraryItem(+Version)`, `TemplateClause` |
| `Contract`, `ContractVersion` | existants (+ champs renouvellement / préavis / Chatel) |
| `Annex` | `Annex` (rattachée à une `ContractVersion`) |
| `Amendment` | contrat `type = AMENDMENT` (choix historique RM-17, conservé) |
| `PricingSchedule`, `PricingLine`, `PriceIndex(+Value)`, `PriceOverride` | nouveaux, `packages/pricing` pour le calcul |
| `SignatureRequest` | existant (+ `mode`, `signedDocumentSha256`, lien d'empreintes) |
| `LifecycleEvent` | nouveau (le journal d'audit reste la preuve ; `LifecycleEvent` est la vue métier requêtable) |
| `Deadline` | nouveau ; `Reminder` existant reste le mécanisme d'alerte |
| `StoredDocument` | nouveau, référentiel unique des fichiers (empreinte, taille, MIME, origine) |
| `ApiClient` | nouveau (clé hachée, scopes, débit) |
| `AuditLog` | existant |

## 4. Choix techniques

| Sujet | Choix | Justification |
|---|---|---|
| HTTP | NestJS 10 sur Fastify 4 | brief (Fastify) + existant (NestJS, guard global deny-by-default) |
| Validation | Zod 4 pour tout nouveau code ; class-validator conservé sur les DTO existants | Zod est la source de l'OpenAPI ; migrer 20 DTO existants n'apporte rien |
| OpenAPI | `z.toJSONSchema()` (Zod 4 natif) → document 3.1 assemblé à la main, servi à `/api/v1/openapi.json`, doc navigable auto-hébergée `/api/v1/docs` | aucune dépendance CDN |
| Client TS | `openapi-typescript` + petit wrapper `fetch` → `packages/contrats-client` (`@lsi/contrats-client`) | publiable sur GitHub Packages |
| Auth API publique | **clé d'API hachée en base** (`ctr_<prefix>_<secret>`, SHA-256 + comparaison à temps constant) | plus simple qu'OAuth2 CC pour des services internes ; rotation par client ; documenté `07-api.md` |
| Formules | parseur maison (descente récursive, liste blanche de fonctions), arithmétique décimale exacte (`decimal.js`) | brief : sans `eval` |
| Arrondi | au centime, **demi à l'écart de zéro** (arrondi commercial), à la ligne ; TVA calculée sur le total HT par taux | usage comptable français, testé |
| Montants | `BigInt` centimes pour les totaux ; prix unitaires `Decimal(20,6)` en euros | un prix unitaire peut avoir des fractions de centime (0,0125 €/Go) |
| File | BullMQ + Redis (existant) | éprouvé, déjà en production |
| OCR | conteneur `ocr` : `ocrmypdf` + `tesseract-ocr-fra` + mini-serveur HTTP interne | auto-hébergé, aucune donnée ne sort |
| PDF | Gotenberg 8 (existant) | JS désactivé, liste blanche `file:///tmp` |
| Stockage | MinIO (S3) avec versioning ; clés `t/{tenant}/c/{customer}/…` | originaux jamais remplacés |
| Postgres | **17** partout (CI annexe A, stack, testcontainers) | alignement demandé par `ci.yml` |

## 5. Flux principaux

1. **Contrat depuis un modèle** : assistant (client → origine → contenu →
   annexes → barème → revue → envoi) → `DRAFT` → `IN_REVIEW` → `APPROVED` →
   `SENT_TO_CLIENT` ⇄ `IN_NEGOTIATION` → `ACCEPTED` → rendu PDF figé (SHA-256)
   → DocuSeal `/submissions/pdf` → webhooks → `SIGNED` → `ACTIVE` (job).
2. **Import** : PDF → SHA-256 + `StoredDocument` (original intouchable) →
   job OCR → extraction règles (+ LLM pseudonymisé si flag) →
   `IMPORTED_PENDING_VALIDATION` → validation humaine côte à côte → `ACTIVE`.
3. **IA** : besoin → requête pseudonymisée → Perplexity (`json_schema`,
   `web_search`, `fetch_url`) → validation Zod → réinjection locale →
   `DRAFT` `origin=AI` → validation clause par clause obligatoire.
4. **Échéancier** : job quotidien → recalcul `Deadline` → alertes J-90/60/30/7
   (paramétrables) → notifications + webhooks sortants `contract.renewal_due`.
5. **API publique** : `ApiClient` → scopes → lecture contrats / dates /
   barème à date / devis → ETag, curseur, RFC 9457.

## 6. Hypothèses

Retenues faute d'information, dans le sens le plus prudent (valeur probante →
isolation → souveraineté → réversibilité).

| # | Hypothèse | Justification | Impact si fausse |
|---|---|---|---|
| V2-H1 | On étend l'existant NestJS au lieu de réécrire en Fastify pur. **Validé par le propriétaire.** | 234 commits fonctionnels et testés | — |
| V2-H2 | La frontière d'isolation reste **tenant + client** (RLS existante), le tenant restant LSI-Maintenance. Les « MSP partenaires » futurs sont des tenants distincts. | modèle existant, plus strict que le brief | aucun |
| V2-H3 | Front : on garde React + Vite + TanStack Query + Tailwind de l'existant ; les jetons de la charte lticket (`LSIParis/ticket`, `apps/console/src/styles.css`) sont reproduits dans `apps/web/src/ui/theme/`. | lticket n'expose pas de paquet partagé | extraction `@lsi/ui` proposée |
| V2-H4 | Portainer **Community Edition** est supposée tant que l'édition n'est pas confirmée ; le workflow `deploy.yml` tolère l'absence de `PORTAINER_WEBHOOK_ID`. | les webhooks de stack sont réservés à la BE | procédure manuelle documentée |
| V2-H5 | Préproduction : `https://contrats-preprod.lsi-maintenance.fr`, même VPS, stack `contrats-preprod`. | le brief laisse la valeur ouverte | changer `APP_URL` de l'environnement `staging` |
| V2-H6 | DocuSeal : le webhook s'authentifie par **HMAC `X-Docuseal-Signature`** (vérifié dans la source DocuSeal, R6 levé le 2026-07-17), complété par un en-tête secret optionnel `DOCUSEAL_WEBHOOK_HEADER_SECRET`. | la version installée signe en HMAC | aucun : le secret partagé reste possible |
| V2-H7 | L'appel Perplexity se fait en `fetch` direct et non via le SDK `@perplexity-ai/perplexity_ai`. | fixtures rejouables, pas de dépendance à la forme interne du SDK ; le contrat HTTP est documenté | remplacer l'adaptateur (port inchangé) |
| V2-H8 | Clé d'API hachée plutôt qu'OAuth2 *client credentials*. | services internes, pas d'IdP partagé | ajout d'un endpoint `/oauth/token` sans casser les clés |
| V2-H9 | Arrondi commercial (demi à l'écart de zéro) au centime, **par ligne**, puis TVA par taux sur la somme HT. | pratique comptable courante | un paramètre tenant `pricing.rounding` bascule sur « demi au pair » |
| V2-H10 | La **tacite reconduction** est matérialisée par le job quotidien : au terme d'une période sans dénonciation, une nouvelle `ContractPeriod` est créée (événement système tracé). Cela remplace la règle historique RM-21 (« intention documentaire seulement »), contraire au brief. | la reconduction tacite est un effet de droit ; ne pas l'enregistrer fausserait les dates exposées par l'API | option `renewalMode = NONE` pour revenir au comportement historique |
| V2-H11 | Loi Chatel (L215-1 C. conso) : obligation d'information appliquée si `Customer.isConsumer = true` (consommateur ou non-professionnel), sinon désactivée mais activable par contrat. Information envoyée entre J-90 et J-60 avant la date limite de dénonciation. | texte légal | à faire valider par un juriste |
| V2-H12 | Seuils d'alerte par défaut 90/60/30/7 jours, paramétrables par tenant. | brief | — |
| V2-H13 | PostgreSQL 17 partout. La base de production existante (16) se migre par `pg_dump`/`pg_restore` (procédure `09-exploitation.md`). | `ci.yml` de l'annexe A impose 17 | rester en 16 : changer l'image, le code est compatible |
| V2-H14 | Le reverse proxy existant (openresty, probablement Nginx Proxy Manager) reste en place ; l'enregistrement DNS pointe vers `51.91.98.38`, ce qui suppose un proxy distinct qui relaie vers `51.178.30.81`. La vérification est documentée, rien n'est supposé. | constaté, non vérifiable depuis la passe | voir `09-exploitation.md` §DNS |
| V2-H15 | Redis est conservé comme service auxiliaire (sessions, BullMQ) et MinIO comme stockage objet, en plus des services listés par le brief. | existant en production | — |
| V2-H16 | Jeu de données de démonstration : `pnpm seed`, contrats types explicitement marqués « DÉMONSTRATION ». | brief | — |
| V2-H17 | Prix unitaire calculé arrondi à **6 décimales** par défaut, puis total de ligne au centime (paramètre `pricing.unitPriceScale`). | fidélité à la formule | `unitPriceScale = 2` (écart de quelques centimes, 04 §6.4) |
| V2-H18 | Recherche d'indice `LATEST_PUBLISHED` par défaut (`pricing.indexLookup`), `EXACT_PERIOD` par tenant ou par ligne. | rejouabilité ; pratique Syntec | changer le paramètre |
| V2-H19 | Seuil de double validation des dérogations : 10 % d'écart, comparaison stricte, sur le prix calculé à la date. | brief sans valeur | `pricing.overrideApprovalThresholdPercent` |
| V2-H20 | Une remise porte sur des lignes de même taux de TVA et même récurrence ; pas de ventilation automatique. | décision comptable | ventilation au prorata |
| V2-H21 | Récurrences par défaut : `UNIT`/`TIERED` mensuelles, `HOURLY`/`HOUR_PACK` ponctuelles. | usage MSP | champ `recurrence` |
| V2-H22 | Dates du moteur calendaires ; conversion `Europe/Paris` à la frontière API. | aucun fuseau dans une règle de prix | — |
| V2-H23 | Valeur d'indice simulée sans date de publication : publiée le 1er jour de sa période. | simuler une révision à venir | préciser `publishedAt` |
| V2-H24 | Révision annuelle : une date de révision passée, sur une version de barème sans fin, annonce l'échéance `PRICE_REVISION` à la date anniversaire. | usage des clauses Syntec | périodicité par ligne |
| V2-H25 | Import d'indice sans date de publication : réputée publiée le jour de l'import. | seule date certaine | fournir la 3ᵉ colonne CSV |
| V2-H26 | Devis catalogue sans taux précisé : TVA 20 %. | taux normal | `vatRatePercent` |
| V2-H27 | Le catalogue de règles est l'état courant (non versionné) : le figer = ligne MANUAL ou grille par millésime. | simplicité | versionner le catalogue |
| V2-H28 | Une correction de valeur d'indice vaut rétroactivement (erratum). | une correction corrige une erreur | rejouer « tel que connu à la date » |
| V2-H29 | Une dérogation en attente de seconde validation n'est jamais appliquée, même si l'écart retombe sous le seuil. | sens le plus prudent | la transmettre au moteur |
| V2-H30 | L'extraction assistée par LLM d'un import est déclenchée par une action explicite, jamais automatiquement par le job OCR. | envoyer un document client à un sous-traitant se décide au cas par cas | l'enchaîner à l'OCR quand `contrats.ai.enabled` est actif |
| V2-H31 | Une rédaction IA en mode `replace` fait passer `contracts.origin` de `NATIVE` à `AI` ; `append` ne la change pas. | l'origine qualifie le texte dominant | champ dédié |
| V2-H40 | Propositions (lot 9) : statuts en codes anglais (`DRAFT`… `WITHDRAWN`, 11-propositions §3) ; **REMPLACÉE** est un état de la **version** (`proposal_versions.superseded_at`), pas de la proposition. | une proposition continue quand sa version est remplacée | statut dédié |
| V2-H41 | Modifier une proposition envoyée (`REVISE`) remplace la version envoyée **immédiatement** (liens révoqués, destinataires prévenus), pas seulement au prochain envoi. | lecture la plus prudente : une version en cours de modification ne doit plus pouvoir être acceptée | remplacement à l'envoi de la v+1 |
| V2-H42 | `REVISE` est aussi admis depuis `PRÊTE` (version non encore figée) et `ACCEPTÉE` (acceptée mais non signée) ; jamais depuis `EN_SIGNATURE` (attendre le refus ou l'expiration de la soumission). `RETIRÉE`/`REFUSÉE`/`EXPIRÉE` seulement depuis `ENVOYÉE`/`CONSULTÉE`/`EN_DISCUSSION` (brief). | une soumission DocuSeal en cours ne se modifie pas sous les pieds du signataire | révocation DocuSeal puis `REVISE` |
| V2-H43 | Acceptation par clic : `ACCEPTÉE` puis `SIGNÉE` dans la même transaction (événement `COMPLETE_CLICK_ACCEPT`) ; la preuve est la trace d'acceptation (nom, fonction, e-mail vérifié par code, IP, empreinte). | le brief place la signature DocuSeal comme seule autre voie | étape de confirmation interne |
| V2-H44 | Un **prospect** est un `Customer` au statut commercial `PROSPECT` ; les clients existants sont `CLIENT` ; `FORMER_CLIENT` se pose à la main. Passage à `CLIENT` à la signature de la première proposition. Aucune synchronisation Client Help (aucun connecteur dans le dépôt). | modèle d'isolation par client inchangé | connecteur Client Help |
| V2-H45 | Page publique : scope de lien **confiné en base** (acteur CLIENT sans portefeuille + GUC `app.proposal_id`, politiques de lecture `*_link_read`) ; toute écriture déclenchée par la page (suivi, sélection, acceptation) est faite par le service dans le scope système **du client du lien**, après validation du jeton. | un jeton ne doit donner accès à rien d'autre, même en cas de bogue applicatif | — |
| V2-H46 | Les comptes du **portail client** ne voient pas les propositions (suivi de lecture, échanges) : le client y accède par son lien personnel. | minimisation | ouvrir une vue portail filtrée |
| V2-H47 | La correspondance modèle de proposition → contrat type passe par un **slug** ajouté à `contract_templates` (migration 31). Les contrats types `infogerance`, `supervision`, `rssi-externalise`, `sauvegarde-en-ligne` n'existent pas encore (pas de seed du lot 2) : la conversion d'une proposition issue d'un de ces modèles **échoue explicitement** tant qu'ils ne sont pas créés (annexe C, règle 8). | ne pas fabriquer un contrat sans son texte type | créer les contrats types et poser leur slug |
| V2-H48 | Le moteur gère la récurrence **trimestrielle** (`QUARTERLY` : ÷ 3 au mois, × 4 à l'année) plutôt que d'approcher une ligne trimestrielle par une ligne annuelle. | « une divergence se corrige dans le moteur » (annexe C) | — |
| V2-H49 | Le complément de minimum mensuel est une ligne `FLAT_MONTHLY` du barème du moteur (recalculé par `priceAt`) ; il est repris tel quel dans le barème initial du contrat. | prix affiché = prix figé = barème initial | le recalculer à chaque révision |
| V2-H50 | TVA du total sur la durée d'engagement = somme des TVA de période (TVA mensuelle × mois + …), chaque période étant facturée avec sa propre TVA arrondie. | ce que le client paiera effectivement | TVA sur le total HT |
| V2-H51 | Tableau de prix d'une proposition = document JSON de la version (forme de l'annexe C, validé par son schéma Zod) plutôt que des tables `PricingTable` / `PricingOption`. | immuable avec la version, évalué d'un bloc par le moteur | tables normalisées |
| V2-H52 | Bibliothèque de contenus « versionnée » = compteur `version` + journal d'audit + texte **figé** dans chaque version de proposition envoyée. | aucune proposition envoyée ne dépend d'un contenu modifiable | table d'historique |
| V2-H53 | Seed de l'annexe C : tenant `lsi` par défaut (`SEED_TENANT_SLUG`), slug du tenant LSI-Maintenance dans ce dépôt, au lieu de `lsi-maintenance`. | convention du dépôt | `--tenant=` |
| V2-H54 | Module désactivé (`contrats.proposals.enabled`) = routes de propositions et page publique en 404 ; l'**administration** (modèles, bibliothèque, CGV, prix à valider) reste accessible pour préparer la bascule. | tout valider avant d'ouvrir | tout masquer |
| V2-H55 | Revue interne : seuils par défaut remise > 10 %, total HT sur la durée > 30 000 € (`proposals.reviewDiscountPercent`, `proposals.reviewAmountCents`) ; « clause dérogatoire » = contenu de bibliothèque ou de CGV modifié (empreinte du texte source) ; valideur = tout `LEGAL_REVIEWER` / `MSP_ADMIN` distinct de l'auteur (pas de valideur nominatif). | brief sans valeur | paramètres du tenant |
| V2-H56 | Contre-signature LSI d'une proposition : `proposals.lsiSignerUserId`, à défaut le commercial propriétaire. | un signataire doit exister | désigner un signataire interne |
| V2-H57 | Référence du contrat issu d'une proposition : `LSI-AAAA-P<n°>` dérivée du numéro de proposition (unique par tenant) ; créateur enregistré = commercial propriétaire (colonne obligatoire), acteur du journal = SYSTEM. | le compteur historique compte les contrats visibles du scope, faux dans un scope système mono-client | séquence dédiée |
| V2-H58 | Plafond de l'acceptation par clic : total HT sur la durée < 5 000 € (`proposals.clickAcceptMaxCents`). | « petites propositions » | paramètre |
| V2-H59 | Le lien public reste ouvrable 30 jours après l'échéance (`proposals.linkGraceDays`) pour afficher le message d'expiration ; il est révoqué à chaque renvoi, relance ou nouvelle version (un seul lien valide par destinataire). | les jetons ne sont jamais conservés en clair : un renvoi émet un nouveau lien | liens multiples |
| V2-H60 | Suivi détaillé conservé 90 jours après décision ou expiration (`proposals.trackingRetentionDays`), agrégats conservés ; « nouveau lecteur » = navigateur jamais vu sur ce lien (empreinte pseudonyme, 20 au plus). | minimisation (brief §12.5) | durée par tenant |
| V2-H61 | Le PDF « de la version » est rendu une fois à l'envoi avec la configuration proposée par le commercial ; le PDF signé (« bon pour accord ») contient les options **retenues** figées. | « identique au contenu de la version » vs « PDF final incluant les options retenues » | — |
| V2-H62 | Un commercial ne peut pas valider un prix : tout prix modifié ou toute ligne nouvelle d'une proposition est `TO_VALIDATE` jusqu'à validation par un administrateur ; une validation du modèle ne profite qu'aux propositions dont le prix est inchangé. | lecture prudente de l'annexe C règle 7 | déléguer au valideur |
| V2-H63 | La conversion d'une proposition issue d'un modèle exige le contrat type **publié** portant le slug attendu ; sinon elle échoue explicitement (erreur tracée, notifiée, retentée). Une proposition « vierge » (sans modèle) est convertie avec un texte vide. | annexe C règle 8 ; ne pas fabriquer un contrat sans son texte | contrat sans clauses |
| V2-H64 | Conversion : date d'effet = date souhaitée (`desiredStartDate`), sinon laissée vide (contrat brouillon) ou date de signature (proposition valant contrat) ; reconduction `NONE` (à fixer par le juriste sur le contrat) ; révision Syntec à la date anniversaire des lignes indexées. | aucune donnée de reconduction dans les modèles | champs dédiés au modèle |
| V2-H65 | Les comptes du portail et la page publique n'ont aucun accès aux modèles, à la bibliothèque et aux paramètres ; la page publique lit les CGV de SA version dans le scope système du client. | classe tenant fermée au client | politique de lecture dédiée |
| V2-H66 | Relance = nouvel e-mail avec un **nouveau** lien personnel (l'ancien est révoqué) ; « réponse du client » (qui suspend les relances) = question, acceptation ou refus. | les jetons ne sont jamais conservés en clair | — |

## 7. Ce qui n'est pas dans le périmètre

- Signature avancée ou qualifiée eIDAS (voir `06-docuseal.md` §eIDAS).
- Facturation (l'API expose les tarifs ; la facturation reste dans les outils de la suite).
- Connecteur réel `QuantityProvider` vers le RMM de Client Help : interface et
  implémentation factice seulement ; le branchement est documenté.
