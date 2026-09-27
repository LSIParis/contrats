# 11 — Propositions commerciales (lot 9)

> Axe **amont** du cycle contractuel (brief §12, annexe C) : propositions web
> interactives, tableau de prix à options calculé par le moteur, suivi de
> lecture, relances, expiration, acceptation par clic ou signature DocuSeal,
> conversion automatique en contrat.
>
> **Livré** : sous-lots 9.1 à 9.7 (données, machine à états, modèles et seed de
> l'annexe C, tableau de prix, page publique, envoi / suivi / relances,
> acceptation et signature, conversion). **À venir** : 9.8 (pipeline, tableau
> de bord, rapports, API publique `/api/v1/proposals`, OpenAPI et client
> régénérés) et 9.9 (assistance IA à la rédaction). Hypothèses : `00-architecture.md`
> §6, V2-H40 à V2-H66.

## 1. Règles structurantes et bascule

| Règle (brief §12) | Réalisation |
|---|---|
| Module derrière `contrats.proposals.enabled` | drapeau de tenant, désactivé par défaut. Désactivé, le module **n'existe pas** : 404 `PROPOSALS_DISABLED` sur toute route (interne et publique). L'administration (modèles, bibliothèque, CGV, « Prix à valider ») reste accessible pour tout préparer avant la bascule (V2-H54). |
| « Tout nouveau contrat naît d'une proposition signée » derrière `contrats.proposals.required` | `POST /v1/contracts` refuse (422 `PROPOSAL_REQUIRED`) toute création directe, sauf par un `MSP_ADMIN` avec `directCreationReason` (≥ 10 caractères), tracé dans le journal d'audit (`contract.direct_creation`). Import, avenant et renouvellement ont leurs propres routes et ne sont pas concernés. |
| Réutiliser, jamais dupliquer | moteur `@lsi/pricing` (calcul), adaptateur et pipeline de webhooks DocuSeal, rendu PDF Gotenberg, stockage `DOCUMENT_STORAGE` et empreintes, audit chaîné, webhooks sortants (outbox), notifications et e-mails. |
| Aucun contrat existant modifié | migrations **additives** (30, 31, 32) ; `contracts.proposal_id` nullable ; les contrats importés et en cours sont intacts (suite complète verte). |

## 2. Parcours

```
Commercial                                  Client (lien personnel)                    Système
──────────                                  ───────────────────────                    ───────
création (modèle annexe C ou vierge)
rédaction : blocs, bibliothèque, CGV,
  balises, import Word, tableau de prix
[revue interne si remise / clause
  dérogatoire / montant > seuil]
PRÊTE (aucune balise non résolue,
  aucun élément « à valider »)
envoi ──────────────────────────────────►  e-mail « au nom du commercial »
  version FIGÉE (empreinte), liens          /p/<jeton> : lecture (suivi),
  personnels (jetons hachés), relances       configuration des options
  planifiées (J+3, J+7, J-2)                 (recalcul serveur), questions
                                             ├─ refuse (motif) ─► REFUSÉE
                                             └─ accepte ─► PricingSnapshot figé
                                                 ├─ clic (code e-mail) ─► SIGNÉE
                                                 └─ DocuSeal intégré ─► EN_SIGNATURE
                                                        webhook submission.completed ─► preuves archivées ─► SIGNÉE
                                                                                          conversion (worker) ─► CONVERTIE
                                                                                          contrat BROUILLON origin=PROPOSAL,
                                                                                          barème initial = PricingSnapshot
```

## 3. Machine à états

Fonction pure `applyProposalEvent` (`packages/domain/src/proposal/state-machine.ts`),
testée exhaustivement (13 états × 20 événements, transitions autorisées **et**
interdites). Codes anglais en base, libellés français à l'écran.

| Brief | Code | Événements possibles (gardes) |
|---|---|---|
| BROUILLON | `DRAFT` | `SUBMIT_FOR_REVIEW`, `MARK_READY` (préparation OK, revue non requise) |
| EN_REVUE_INTERNE | `IN_INTERNAL_REVIEW` | `APPROVE_REVIEW` → PRÊTE, `REJECT_REVIEW` (motif) → BROUILLON ; valideur ≠ auteur de la soumission |
| PRÊTE | `READY` | `SEND` (échéance future), `REVISE` → BROUILLON |
| ENVOYÉE | `SENT` | `VIEW`, `EXPIRE`, `DECLINE`, `WITHDRAW`, `REVISE` |
| CONSULTÉE | `VIEWED` | `OPEN_DISCUSSION`, `ACCEPT`, `EXPIRE`, `DECLINE`, `WITHDRAW`, `REVISE` |
| EN_DISCUSSION | `IN_DISCUSSION` | `CLOSE_DISCUSSION` → CONSULTÉE, `ACCEPT`, `EXPIRE`, `DECLINE`, `WITHDRAW`, `REVISE` |
| ACCEPTÉE | `ACCEPTED` | `START_SIGNATURE` (mode DocuSeal, non expirée, version acceptée = courante), `COMPLETE_CLICK_ACCEPT` (mode clic), `REVISE` |
| EN_SIGNATURE | `PENDING_SIGNATURE` | `SIGNATURE_COMPLETED` → SIGNÉE, `SIGNATURE_DECLINED` / `SIGNATURE_EXPIRED` → EN_DISCUSSION |
| SIGNÉE | `SIGNED` | `CONVERT` → CONVERTIE |
| CONVERTIE | `CONVERTED` | — (terminal) |
| EXPIRÉE | `EXPIRED` | `REACTIVATE` → PRÊTE (nouvelle date future + motif obligatoires) |
| REFUSÉE | `DECLINED` | — (terminal ; motif codé `PRICE`, `COMPETITOR`, `TIMING`, `SCOPE`, `NO_PROJECT`, `OTHER` + texte libre) |
| RETIRÉE | `WITHDRAWN` | — (terminal ; motif obligatoire) |
| REMPLACÉE | *(version)* | `proposal_versions.superseded_at` : une version envoyée est remplacée dès qu'on la **révise** (V2-H41) ; ses liens sont révoqués, les destinataires prévenus |

**Gardes de préparation** (`SUBMIT_FOR_REVIEW`, `MARK_READY`, `APPROVE_REVIEW`,
et revérifiées à l'envoi) : au moins un destinataire et un signataire (un
décideur suffit en acceptation par clic), **aucune balise de fusion non
résolue** (ni inconnue, ni sans valeur, ni « [à compléter] », ni bloc
« Votre contexte » vide, ni CGV absentes), **aucun élément `TO_VALIDATE`
retenu** (ligne, règle appliquée, choix, section conservée — annexe C
règle 7), tableau de prix calculable, seuil d'acceptation par clic respecté.

**Revue interne obligatoire** (`review_required`, recalculé à chaque
modification) si : une remise appliquée dépasse `proposals.reviewDiscountPercent`
(10 %), un contenu de référence (bibliothèque, CGV) a été modifié — **clause
dérogatoire**, détectée par empreinte du texte source —, ou le total HT sur la
durée dépasse `proposals.reviewAmountCents` (30 000 €). Valideur : rôle
`LEGAL_REVIEWER` ou `MSP_ADMIN`, distinct de l'auteur de la soumission (V2-H55).

**Un seul chemin d'écriture du statut** : `persistProposalTransition`
(`apps/api/src/proposals/proposal-transition.ts`) — la machine décide, le
contexte (événement, motif) est posé pour le trigger `proposals_status_transition`
qui écrit `proposal_lifecycle_events` **et** la piste d'audit chaînée
(`proposal.transition`), puis l'événement sortant `proposal.*` est publié dans
la même transaction (outbox).

## 4. Modèle de données (migrations 30 à 32)

| Entité (brief §12.1) | Table(s) | Classe |
|---|---|---|
| `ContentLibraryItem` | `content_library_items` (compteur `version`, `user_modified_at`) | tenant |
| CGV versionnées | `proposal_terms` (immuable, empreinte) | tenant |
| `ProposalTemplate` | `proposal_templates`, `proposal_template_sections`, `proposal_template_pricing_lines` (forme de l'annexe C + `signed_proposal_is_contract`) | tenant |
| numérotation | `proposal_sequences` (compteur atomique par tenant et par année) | tenant |
| `Proposal` | `proposals` (numéro `PROP-AAAA-NNNN`, commercial, statut, échéance, mode d'acceptation, montants synthèse, contrat généré) | client |
| `ProposalVersion` | `proposal_versions` (figée à l'envoi : trigger `proposal_versions_guard`) | client |
| `ProposalSection` / `ProposalBlock` | `proposal_sections`, `proposal_blocks` (figés avec la version) | client |
| `PricingTable` / `PricingOption` | document JSON `proposal_versions.pricing_definition` (V2-H51) | client |
| `ProposalSelection` | `proposal_selections` (append-only, la dernière fait foi) | client |
| `PricingSnapshot` | `pricing_snapshots` (immuable, SHA-256 de l'ensemble) | client |
| `ProposalRecipient` | `proposal_recipients` (décideur, signataire, lecteur ; ordre) | client |
| `ProposalAccessLink` | `proposal_access_links` (SHA-256 du jeton, expiration, révocation, code à usage unique) | client |
| `ProposalViewEvent` | `proposal_view_events` (détail purgeable) + `proposal_view_stats` (agrégats conservés) | client |
| `ProposalComment` | `proposal_comments` | client |
| `ProposalFollowUp` | `proposal_follow_ups` (planifiées / envoyées / sautées / annulées) + `proposal_deliveries` (historique des envois) | client |
| acceptation, signature | `proposal_acceptances`, `proposal_signature_requests`, `proposal_signers`, `proposal_signature_events` | client |
| liens avec l'existant | `contracts.proposal_id` (UNIQUE) + `signed_via_proposal`, `ContractOrigin.PROPOSAL`, `customers.commercial_status` (`PROSPECT`/`CLIENT`/`FORMER_CLIENT`), `contract_templates.slug`, `stored_documents.proposal_id`, `notifications.related_proposal_id`, `PricingRecurrence.QUARTERLY` | — |

RLS partout (`ENABLE` + `FORCE`, politiques `TO lsi_app`, `USING` + `WITH CHECK`) :
tenant → `tenant_id` ; client → tenant + portefeuille, **jamais** un acteur
`CLIENT` (V2-H46). Politiques supplémentaires `*_link_read` en **lecture seule**
pour la page publique (§6). FK composites `(id, tenant_id, customer_id)`.

## 5. Tableau de prix interactif

**Aucun calcul de prix hors du moteur** (brief §12.4). `quoteProposal`
(`packages/pricing/src/proposal.ts`) :

1. **configure** : choix exclusifs (formule, durée), options cochées,
   quantités par défaut (balises `{{parc.*}}`), lignes liées (mise en service),
   règles `REQUIRES`, `REQUIRED_IF_ANY`, `AUTO_INCLUDE`, `AT_LEAST_ONE`,
   `PRESELECT_CHOICE`, bornes (min, max, `maxFrom`) — **aucun montant** ;
2. **calcule** : la configuration devient un barème du moteur (lignes
   `MANUAL`, prix unitaires du modèle, remise `DISCOUNT` en pourcentage sur les
   lignes ciblées), évalué par `priceAt` ; le **complément de minimum
   mensuel** est une ligne `FLAT_MONTHLY` ajoutée puis recalculée (V2-H49) ;
   les tarifs affichés (hors forfait) sont au barème en quantité 0 ;
3. **ventile** : ponctuel, mensuel, trimestriel (récurrence `QUARTERLY` du
   moteur, V2-H48), annuel, et **total sur la durée** = mensuel × mois +
   trimestriel × (mois / 3) + annuel × (mois / 12), chacun en HT / TVA / TTC
   (`computeTotals` du moteur ; TVA du total = somme des TVA de période, V2-H50).

Le client ne modifie que ce que le modèle lui ouvre (`editableByClient`) ;
chaque modification est recontrôlée côté serveur, recalculée, **enregistrée**
(`proposal_selections`) et notifiée au commercial (au plus une notification
par quart d'heure).

**Prix affiché = prix figé = barème initial**, par construction : à
l'acceptation, la configuration et le **barème du moteur** qui a produit le
prix affiché sont figés dans `pricing_snapshots` (empreinte SHA-256) ; la
conversion écrit **ces mêmes lignes** comme version 1 du barème du contrat. Le
test de bout en bout recalcule les deux barèmes avec `priceAt` et exige des
totaux strictement égaux, et égaux au prix affiché au moment de l'acceptation.

**Même résultat que le moteur** (annexe C, règle 6) :
`packages/persistence/test/seed/proposal-templates.engine.test.ts` adapte
`quoteProposal` à `PricingEvaluator` et exige `runControlCases` vide pour les
quatre modèles (1 515,00 € / 1 362,50 € HT par mois pour l'infogérance ;
1 395,00 € et 6 885,00 € HT pour le RSSI avec DPO ; 294,75 €, 301,00 € et
49,00 € HT pour la sauvegarde en ligne…). `reference-pricing.ts` n'est jamais
appelé en production.

## 6. Page publique `/p/<jeton>`

| Exigence | Réalisation |
|---|---|
| Lien distinct par destinataire, ≥ 128 bits | 256 bits (`randomBytes(32)`, base64url) ; **seul le SHA-256 est stocké** ; forme stricte vérifiée avant tout hachage |
| Résolution sans session | fonction `app_resolve_proposal_link` (SECURITY DEFINER, identifiants seuls) |
| Aucune donnée d'une autre proposition | **scope de lien confiné en base** : acteur `CLIENT` sans portefeuille + GUC `app.proposal_id` ; seules les politiques de LECTURE `*_link_read` de CETTE proposition s'ouvrent (V2-H45). Les écritures (suivi, configuration, questions, décision) passent par le service, dans le scope système du SEUL client du lien, filtrées par la proposition résolue |
| Expiration, révocation | lien valable jusqu'à l'échéance + `proposals.linkGraceDays` (30 j, pour afficher le message d'expiration) ; révoqué par un renvoi, une relance, une nouvelle version (410 `LINK_REVOKED` / `LINK_EXPIRED`) |
| Code à usage unique | propositions **sensibles** (aucun contenu avant vérification) et **acceptation par clic** : code 6 chiffres par e-mail, 10 min, 5 essais, haché avec l'identifiant du lien ; délivre une session d'1 h (en-tête `x-proposal-otp`, hachée en base) |
| `noindex`, CSP stricte, débit | `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (API et page SPA `/p/*`) ; CSP de l'application (aucune ressource tierce, DocuSeal seul autorisé en cadre) ; limitation de débit Redis par IP et par lien |
| Export PDF à tout moment | PDF de la **version** rendu et haché une fois à l'envoi (Gotenberg), stocké en écriture unique (`stored_documents`, `PROPOSAL_PDF`), relu tel quel |
| Questions par section | `POST …/comments` ; réponse du commercial dans l'application ; ouvre la discussion (`IN_DISCUSSION`) |

Routes publiques (toutes `@Public()`, figées par `tests/structural/scope-surface.test.ts`) :
`GET /v1/public/proposals/:token`, `POST …/events`, `PUT …/selection`,
`POST …/comments`, `POST …/decline`, `POST …/otp`, `POST …/otp/verify`,
`POST …/accept`, `GET …/pdf`.

## 7. Envoi, suivi, notifications, relances, expiration

- **Envoi** (`POST /v1/proposals/:id/send`) : revérifie la préparation, fige la
  version (valeurs de fusion avec l'échéance réelle, tableau de prix, empreinte
  `content_sha256`), crée un lien par destinataire, acte `SEND`, planifie les
  relances, puis — après commit — rend le PDF et envoie les e-mails (modèle
  paramétrable `proposals.emailSubject` / `proposals.emailBody`, expéditeur
  « <commercial> — LSI Maintenance », réponse au commercial, adresse d'envoi
  du domaine : SPF / DKIM / DMARC respectés). Chaque e-mail est tracé dans
  `proposal_deliveries` (erreur comprise). **Renvoi** en un clic
  (`/resend`) : nouveau lien, l'ancien est révoqué.
- **Échéance** : date fixe (`fixedExpiryDate`, fin de journée à Paris) ou
  N jours après l'envoi (30 par défaut) ; le balayage (5 min) passe EXPIRÉE ;
  la page affiche un message dédié et refuse acceptation et signature.
- **Suivi de lecture** : balise groupée (`POST …/events`, 50 événements max) —
  ouverture, temps par section (IntersectionObserver côté page), téléchargement
  PDF, **nouveau lecteur** (navigateur jamais vu sur ce lien : empreinte
  pseudonyme `SHA-256(lien, identifiant aléatoire local)`, 20 au plus), dernière
  activité. Agrégats par section dans `proposal_view_stats`.
- **Notifications** au commercial : ligne `notifications` (dédoublonnée) +
  flux **SSE** `GET /v1/proposals/stream` (Redis pub/sub, tous conteneurs) +
  e-mail pour : première ouverture, retour après plus de 3 jours, question,
  option modifiée, acceptation, signature, refus, refus de signature, échec de
  conversion.
- **Relances** : planifiées à l'envoi (J+3 sans ouverture, J+7 sans décision,
  J-2 avant échéance, paramétrables par proposition, désactivables) ; au moment
  dû, `decideFollowUp` (domaine) les **suspend** si le client a répondu ou si
  une discussion est ouverte, les **reporte** pour respecter **48 h minimum**
  entre deux relances. Une relance envoie un nouveau lien personnel.

## 8. Suivi de lecture et RGPD

Voir aussi `08-securite-rgpd.md` §7. Le suivi porte sur des personnes
physiques : **aucun traceur tiers** ni outil d'analyse externe ; **bandeau
d'information** sur la page ; **IP tronquée** (/24, /48) ; granularité limitée
au nécessaire commercial (ouverture, temps par section, téléchargement) ;
**purge** quotidienne du détail des propositions décidées ou expirées depuis
`proposals.trackingRetentionDays` (90 j par défaut), **agrégats conservés**
(`app_purge_proposal_view_events`, bornée au tenant). L'acceptation par clic
conserve en revanche l'IP **complète** : c'est une preuve (autre finalité,
autre base légale).

## 9. Acceptation et signature

| Mode | Parcours | Preuve |
|---|---|---|
| `DOCUSEAL_SIGNATURE` (défaut) | signataire désigné → « Accepter et signer » : la configuration est **figée** (`PricingSnapshot`), acceptation tracée, `ACCEPTÉE` ; le PDF final (version + options RETENUES + CGV + zone de signature à balises textuelles) est rendu et **haché avant l'envoi** ; soumission `POST /submissions/pdf` par l'**adaptateur existant**, signature **intégrée** (`embed_src`) ; `EN_SIGNATURE`. Contre-signature LSI si le modèle le prévoit (`providerCountersign`), par `proposals.lsiSignerUserId` ou le commercial (V2-H56). | PDF signé + journal d'audit DocuSeal rapatriés et archivés, empreintes et relation envoyé ↔ signé |
| `CLICK_ACCEPT` | total sur la durée < `proposals.clickAcceptMaxCents` (5 000 € HT) ; e-mail **vérifié par code** ; `ACCEPTÉE` puis `SIGNÉE` (V2-H43) | nom, fonction, e-mail vérifié, horodatage, IP, empreinte de la version (CHECK en base : pas d'acceptation par clic sans e-mail vérifié) |

Webhooks : `DocusealWebhookService` (HMAC, parsing, réconciliation) délègue
les soumissions inconnues des contrats à `ProposalSignatureService.process` :
scope résolu depuis `proposal_signature_requests` (rôle `lsi_webhook`, six
colonnes), idempotence par contrainte UNIQUE (`createMany` + `skipDuplicates`,
aucune exception dans la transaction), effets monotones. À
`submission.completed` : job `proposal-capture` → preuves **archivées
localement**, PUIS `SIGNÉE`, le prospect devient `CLIENT`, conversion enfilée
(ordre du brief §12.6). Refus (`form.declined`) ou expiration de la soumission :
retour `EN_DISCUSSION`, commercial notifié ; une nouvelle acceptation crée une
nouvelle soumission. DocuSeal indisponible à l'acceptation : la proposition
reste ACCEPTÉE, `POST /v1/proposals/:id/start-signature` relance.

**Point d'extension paiement** (§12.10, hors V1) : interface `PaymentProvider`
(`packages/domain/src/proposal/payment-provider.port.ts`), sans implémentation ;
emplacement prévu entre la signature et la conversion.

## 10. Conversion en contrat

`ProposalConversionService.convert` — job `proposal-convert` (enfilé à la
signature) et filet du balayage (`app_find_proposals_to_convert`) :

- contrat `BROUILLON`, `origin = PROPOSAL`, `proposal_id` (et
  `proposals.contract_id` : traçabilité bidirectionnelle), référence
  `LSI-AAAA-P<n°>` dérivée du numéro de proposition (V2-H57), client,
  commercial propriétaire, durée d'engagement → date de fin, date d'effet
  souhaitée (`desiredStartDate`), montant mensuel ;
- texte : version **publiée** du contrat type associé
  (`proposal_templates.contract_template_slug` → `contract_templates.slug`),
  clauses copiées, annexes par défaut, variables pré-remplies ; **contrat type
  absent → conversion refusée explicitement** (`conversion_error`, notification,
  retentée par le balayage — annexe C règle 8, V2-H47) ;
- signataires côté client = destinataires signataires ;
- **barème initial = PricingSnapshot**, ligne pour ligne ; révision Syntec
  (a = 0,15, b = 0,85 du modèle) à la date anniversaire pour les lignes indexées ;
- option `signedProposalIsContract` (**désactivée par défaut, à faire valider
  par un juriste**) : contrat directement `ACTIF`, barème `ACTIF`,
  `signed_via_proposal` (signatureMode dérivé `PROPOSAL_SIGNED`), signataires
  signés, `contract.activated` publié ;
- **idempotente** : UNE transaction, contrainte `contracts_proposal_key`
  (UNIQUE) ; un webhook rejoué ou deux jobs concurrents ne créent jamais deux
  contrats (le second relit l'existant).

Le contrat poursuit ensuite **son propre cycle de vie** (revue, envoi,
signature DocuSeal, activation).

## 11. Drapeaux, paramètres, permissions

| Drapeau | Sens |
|---|---|
| `contrats.proposals.enabled` | active le module (désactivé par défaut) |
| `contrats.proposals.required` | tout nouveau contrat naît d'une proposition signée (création directe : admin + motif) |

| Paramètre (défaut) | Rôle |
|---|---|
| `proposals.reviewDiscountPercent` (10) | revue obligatoire au-delà |
| `proposals.reviewAmountCents` (3 000 000) | revue obligatoire au-delà (total HT sur la durée) ; `null` = jamais |
| `proposals.clickAcceptMaxCents` (500 000) | plafond de l'acceptation par clic |
| `proposals.defaultValidityDays` (30) | validité après envoi |
| `proposals.followUps` (3 / 7 / 2) | relances par défaut |
| `proposals.trackingRetentionDays` (90) | conservation du suivi détaillé |
| `proposals.linkGraceDays` (30) | lien ouvrable après l'échéance (message d'expiration) |
| `proposals.emailSubject`, `proposals.emailBody` | modèle d'e-mail (`{{lien}}` obligatoire) |
| `proposals.lsiSignerUserId` (null) | contre-signataire LSI (null = commercial) |

| Action (`permissions.ts`) | Rôles |
|---|---|
| `proposals.read` | MSP_ADMIN, ACCOUNT_MANAGER, LEGAL_REVIEWER, INTERNAL_SIGNATORY, READER |
| `proposals.write` (rédiger, destinataires, réviser, retirer, répondre) | MSP_ADMIN, ACCOUNT_MANAGER |
| `proposals.send` (envoyer, renvoyer, réactiver, relancer la signature) | MSP_ADMIN, ACCOUNT_MANAGER |
| `proposals.review` (valider / refuser la revue interne) | MSP_ADMIN, LEGAL_REVIEWER |
| `proposals.library.manage` (modèles, bibliothèque, CGV, slug des contrats types) | MSP_ADMIN |
| `proposals.prices.validate` (« Prix à valider », sections et prix d'une proposition) | MSP_ADMIN |
| `proposals.convert` (relance manuelle de la conversion) | MSP_ADMIN, ACCOUNT_MANAGER |

Le client (portail) n'a **aucun** droit sur les propositions : il y accède par
son lien personnel.

## 12. Seed des modèles (annexe C)

### 12.1 Emplacement et branchement

Les fichiers de l'annexe C sont repris **tels quels** sous
`packages/persistence/prisma/seed/proposal-templates/` (Prisma vit dans
`packages/persistence` dans ce dépôt) et les tests sous
`packages/persistence/test/seed/`. Seuls `mapTemplateToPrisma` et
`createPrismaSeedRepository` (`repository.ts`) sont adaptés (Prisma 5.22,
identifiants UUIDv7, `tenant_id` sur les sections et lignes), et le tenant par
défaut de `cli.ts` est `lsi` (V2-H53). `proposal-templates.prisma` reste le
fragment de référence ; les modèles effectifs sont dans `schema.prisma`.

| Commande | Effet |
|---|---|
| `pnpm db:seed` | tous les seeds de référence (`packages/persistence/prisma/seed.ts`) |
| `pnpm db:seed:propositions -- --dry-run` | rapport sans écriture |
| `pnpm db:seed:propositions -- --force` | restaure la version des fichiers (efface `userModifiedAt`) |
| `pnpm db:seed:propositions -- --tenant=<slug>` | autre tenant (sinon `SEED_TENANT_SLUG`, sinon `lsi`) |
| `pnpm --filter @lsi/persistence test:seed` | 38 tests (31 de l'annexe C + 7 « même résultat que le moteur »), sans base |

**Déploiement** : le job `migrate` (`deploy/migrate.sh`) exécute le seed après
`prisma migrate deploy` si `SEED_PROPOSAL_TEMPLATES=true` (activé en
préproduction et en production, `stack.env.example`). Un fichier invalide ou
un cas de contrôle en échec fait échouer le job : `app` et `worker` ne
démarrent pas et le déploiement est annulé.

### 12.2 Format des fichiers

- Montants en **centimes HT** (entiers), TVA 20 % au niveau du modèle.
- `pricing` : `{ "unitPriceCents": n }` ou `{ "dependsOn": "<choix>", "byChoice": { "<valeur>": n } }` ; `byChoice` couvre exactement les valeurs du choix.
- `priceStatus` : `VALIDATED` (offre LSI existante, source dans `priceSource`) ou `TO_VALIDATE` ; `priceStatusByChoice` précise par valeur (formule PME du RSSI).
- Règles : `MINIMUM_MONTHLY`, `REQUIRES`, `REQUIRED_IF_ANY`, `AUTO_INCLUDE`, `AT_LEAST_ONE`, `DISCOUNT_PERCENT`, `PRESELECT_CHOICE` — évaluées par le moteur, jamais par l'interface.
- Total sur la durée : mensuel × mois + trimestriel × (mois / 3) + annuel × (mois / 12), hors mise en service.
- Comportement par élément : `CREATED`, `UPDATED` (version du fichier supérieure), `UNCHANGED`, `SKIPPED_MODIFIED` (modifié dans l'interface), `SKIPPED_NEWER` ; un contenu modifié **sans** incrément de `seedVersion` est refusé et rien n'est écrit ; tout est validé avant la première écriture.

### 12.3 Procédure de modification d'un prix

**Par le fichier** (prix catalogue, recommandé) :

1. modifier le JSON du modèle (`packages/persistence/prisma/seed/proposal-templates/*.json`) ;
2. **incrémenter `seedVersion`** du modèle ;
3. mettre à jour les `controlCases` concernés (montants attendus) ;
4. lancer `pnpm --filter @lsi/persistence test:seed` (fichiers, cas de contrôle **et** moteur) ;
5. commiter ; le déploiement rejoue le seed (`UPDATED`).

Une divergence entre la référence et le moteur se corrige dans le moteur, ou
dans le JSON avec un incrément de `seedVersion` — **jamais en assouplissant le test**.

**Par l'interface** (`PATCH /v1/proposal-admin/templates/:slug/lines/:key`,
administrateur) : le prix modifié repasse **TO_VALIDATE**, le modèle devient
propre au tenant (`userModifiedAt`) et le seed ne le touche plus ; `--force`
restaure la version du fichier. Toute modification est tracée dans le journal d'audit.

### 12.4 Éléments à valider (« Prix à valider »)

`GET /v1/proposal-admin/pending-validations` (écran d'administration) liste,
modèle par modèle, les lignes (et valeurs de choix), règles, sections et choix
`TO_VALIDATE` (même logique que `listPendingValidations`) ;
`POST …/validate` les passe `VALIDATED` (administrateur, tracé
`proposal_template.price_validated`, modèle marqué modifié). Une proposition
déjà créée bénéficie d'une validation du modèle **si son prix est inchangé**
(`withTemplateValidations`) ; un commercial ne peut jamais valider lui-même un
prix (un prix modifié ou une ligne nouvelle est `TO_VALIDATE` ;
`POST /v1/proposals/:id/pricing/validate` est réservé à l'administrateur).

| Modèle | Nombre | Détail (annexe C, C.3) |
|---|---:|---|
| Infogérance | 1 | section « Niveaux de service » (délais de prise en charge) |
| Supervision | 10 | grille de prix de la supervision seule, minimum mensuel, section « Alertes et réaction » |
| RSSI | 5 | formule PME (RSSI et DPO), frais de mise en place TPE-PME et PME, section « Organisation » (volumes de jours) |
| Sauvegarde en ligne | 16 | grille de vente complète (8 lignes récurrentes et options, 5 mises en service), minimum mensuel, sections « Planification et conservation » et « Suivi et restauration » |

Autres éléments **à faire valider par un juriste** : option
`signedProposalIsContract` (désactivée), contenus de bibliothèque marqués
`requiresLegalReview` (conditions infogérance / supervision, conditions RSSI),
CGV à publier (`POST /v1/proposal-admin/terms` : aucune proposition ne part
sans CGV), textes de l'acceptation par clic et du bandeau de suivi.

**Contrats types à créer** (lot 2, aucun seed dans le dépôt) : `infogerance`,
`supervision`, `rssi-externalise`, `sauvegarde-en-ligne`, publiés, avec leur
slug (`PUT /v1/proposal-admin/contract-templates/:id/slug`).

### 12.5 Sources du modèle Sauvegarde en ligne

À revérifier avant la mise en production :
[types d'éléments protégés et tarifs Comet](https://www.cometbackup.com/pricing/),
[architecture Comet (compression, chiffrement, déduplication)](https://docs.cometbackup.com/latest/application-architecture/),
[Object Lock dans Comet](https://docs.cometbackup.com/latest/storage-configuration/s3-object-locking/),
[Proxmox VE en disponibilité générale](https://docs.cometbackup.com/blog/2026/2026-01-27-whats-new/),
[partenariat Comet et Impossible Cloud](https://docs.cometbackup.com/blog/2024/2024-06-26-impossible-cloud-integration/),
[tarifs Impossible Cloud](https://www.impossiblecloud.com/pricing),
[régions et points d'accès Impossible Cloud](https://docs.impossiblecloud.com/impossible-cloud-help/impossible-cloud-storage-guide/storage-console-urls-and-api-endpoints).

## 13. Rédaction

- **Sections et blocs typés** (`RICH_TEXT` en Markdown restreint, `IMAGE`,
  `VIDEO` hébergées, `PRICING_TABLE`, `TIMELINE`, `TEAM`, `REFERENCES`, `FAQ`,
  `TERMS`, `SIGNATURE`), écrits en bloc (`PUT /v1/proposals/:id/sections`) ;
  exactement une section de prix et une de signature. Rendu HTML **assaini**
  (texte échappé puis liste blanche des contrats). L'éditeur par blocs de
  l'interface interne (glisser-déposer, aperçu bureau / mobile) relève du lot 9.8.
- **Bibliothèque** : le texte est copié dans la proposition avec son empreinte
  source (détection des clauses dérogatoires) ; figé à l'envoi.
- **Balises de fusion** typées (`packages/domain/src/proposal/merge-tags.ts`) :
  catalogue fermé, valeurs formatées (montants, dates françaises), valeurs
  saisies filtrées (`mergeContext`), consignes (`guidance`) jamais rendues.
- **CGV** versionnées, immuables ; chaque version de proposition référence la
  version en vigueur à sa création (renouvelée à chaque nouvelle version).
- **Import Word** (`POST /v1/proposals/:id/import-docx`) : lecture de
  `word/document.xml` (sans dépendance), un titre de niveau 1 = une section ;
  archive bornée ; résultat en brouillon, soumis aux mêmes contrôles.
- **Assistance IA** : lot 9.9 (colonne `ai_pending_review` prévue).

## 14. Tests

| Suite | Contenu |
|---|---|
| `packages/domain/tests/proposal-state-machine.test.ts` | matrice exhaustive 13 × 20, gardes (TO_VALIDATE, balises, revue, version remplacée, expiration, modes) |
| `packages/domain/tests/proposal-helpers.test.ts` | balises, numérotation, relances (48 h, suspension), IP tronquée |
| `packages/pricing/tests/proposal.test.ts`, `price-at.test.ts` | configuration + moteur, minimum, remise, trimestriel ; barème rejoué = totaux identiques |
| `packages/persistence/test/seed/*` | 31 tests de l'annexe C + « même résultat que le moteur » (7) |
| `packages/persistence/tests/isolation/propositions.test.ts`, `proposal-seed.test.ts` | RLS (portefeuille, portail, lien confiné en lecture seule, autre tenant), journal par trigger, immuabilité, numérotation concurrente, purge bornée ; seed réel (idempotence, `userModifiedAt`, `--force`, `--dry-run`) |
| `apps/api/tests/isolation/proposals-e2e.test.ts` | **bout en bout sur fixtures** (`test/fixtures/proposals/`) : création → envoi → consultation → options → acceptation → webhook DocuSeal signé → preuves → SIGNÉE → conversion → contrat avec le bon barème (prix affiché = figé = barème) ; acceptation par clic avec code |
| `apps/api/tests/isolation/proposals-isolation.test.ts` | autre client 404, lecteur, portail, autre tenant, module désactivé, jeton confiné / révoqué / malformé, version remplacée et proposition expirée non acceptables, TO_VALIDATE bloque PRÊTE, refus, relances, signature refusée, `proposals.required`, `userModifiedAt`, prix à valider audité, purge RGPD |
| `apps/api/tests/unit/proposals-content.test.ts` | Markdown, import Word, statuts à valider, balises, jetons, fin de journée à Paris |
