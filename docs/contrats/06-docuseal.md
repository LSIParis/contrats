# 06 — Signature électronique : DocuSeal Pro

> Brief §7. Complète `00-architecture.md` (§2 composants, §5 flux 1, hypothèse
> V2-H6). Code : `packages/domain/src/signature/*` (port, balises, ordre,
> empreintes), `apps/api/src/signature/*` (adaptateur, envoi, preuves,
> disponibilité), `apps/api/src/webhooks/*`. Fixtures : `test/fixtures/docuseal/`.

## 1. Contrat d'API vérifié

**Vérifié le 2026-09-26** contre la documentation publique
<https://www.docuseal.com/docs/api> et sa spécification OpenAPI
(`https://console.docuseal.com/openapi.json`, « DocuSeal API » 1.0.0). Les
formes de réponse de `POST /submissions/pdf` et le format HMAC des webhooks
avaient déjà été confirmés contre l'instance de production
(`signe.lsi-maintenance.fr`, image `ds-ee`) le 2026-07-17.

| Élément | Constat | Usage chez nous |
|---|---|---|
| Authentification | en-tête `X-Auth-Token: <clé API>` | toutes les requêtes API ; **jamais** envoyé aux URL de fichiers |
| Base URL | `https://api.docuseal.com` / `.eu` en SaaS ; **auto-hébergé : `https://<hôte>/api`** | `DOCUSEAL_URL` |
| `POST /submissions/pdf` | **Pro** (« Available in Pro »). Corps : `name`, `documents[] {name, file (base64 ou URL), fields?, position?}`, `submitters[] {role, name, email, phone, external_id, order, require_email_2fa, metadata, send_email, message, fields[] {name, default_value, readonly…}, values}`, `send_email` (défaut vrai), `order` `preserved` (défaut) \| `random`, `expire_at` (« 2024-09-01 12:00:00 UTC »), `completed_redirect_url`, `message {subject, body}`, `bcc_completed`, `reply_to`, `merge_documents`, `flatten`, `remove_tags` (défaut **vrai**). Réponse : **objet** `{id, submitters[{id, slug, external_id, embed_src, status…}], fields[…], status}` | voie nominale |
| `POST /submissions` | `template_id` (entier, requis), mêmes options, `submitters[].values` / `fields[].default_value` + `readonly`, `variables`. Réponse : **tableau** de submitters (`submission_id`) | voie secondaire |
| `GET /submissions/{id}` | `status` ∈ `pending, completed, declined, expired` ; `audit_log_url`, `combined_document_url` (souvent `null`), `documents[{name,url}]`, `submitters[{status ∈ awaiting, sent, opened, completed, declined ; opened_at, completed_at, declined_at, external_id…}]`, `submission_events[]` | réconciliation, preuves |
| `GET /submissions/{id}/documents?merge=true` | `{id, documents:[{name, url}]}` — un PDF fusionné ; les documents finaux signés si la submission est complétée | preuve principale |
| `GET /submissions` | filtres `template_id, status, q, slug, template_folder, archived, limit, after, before` — **pas d'`external_id`** | — |
| `GET /submitters` | filtre **`external_id`** (celui d'un signataire), `submission_id`, `q`, `slug`, dates | anti-double-envoi |
| `PUT /submitters/{id}` | `send_email: true` = **renvoyer** l'invitation | relance |
| `DELETE /submissions/{id}` | archive | révocation |
| Sonde | aucun endpoint de santé ni « whoami » documenté ; `GET /templates?limit=1` est l'appel authentifié le plus léger | `checkReadiness()` |
| Relances | aucun paramètre de relance à la création dans l'API | relances pilotées par notre planificateur |
| Webhooks | `form.viewed, form.started, form.completed, form.declined` (data = **submitter**, avec `submission_id` et `submission{id…}`), `submission.created, submission.completed` (« complétée par **toutes** les parties »), `submission.expired, submission.archived` (data = **submission**, `data.id` = id de submission), `template.*` | voir §6 |
| Balises | `{{Nom;role=Rôle;type=…;attr=val}}` ; types `signature, initials, date, datenow` (date de signature, lecture seule), `text`… ; attributs `required` (défaut vrai), `readonly`, `format`, `width`/`height` (px), `font_size`… | voir §3 |

**Correctif découlant de la vérification** : l'ancien
`findSubmissionByExternalId` interrogeait `GET /submissions?external_id=…`,
paramètre inexistant — ignoré, il renvoyait la **dernière submission du
compte**, faux positif qui aurait fait croire qu'un envoi avait abouti. Il
passe désormais par `GET /submitters?external_id=` puis
`GET /submissions/{id}`, et **lève** en cas de panne (« je ne sais pas » n'est
jamais lu comme « elle n'existe pas »).

Non vérifiable depuis la documentation, à confirmer sur l'instance :
possibilité d'ajouter un **en-tête personnalisé** au webhook (réglage
Webhooks → secret clé/valeur) — voir §6.2 ; comportement de la reconstitution
de la balise de paraphe en pied de page — voir §3.3.

## 2. Deux voies de création

### 2.1 Voie nominale — PDF figé + balises textuelles

Chaque contrat est unique : on n'en fait pas un modèle DocuSeal. Le flux
(`SendForSignatureService`) :

1. Rendu Gotenberg (HTML → PDF/A-2b) du corps de la version **+ bloc de
   signature** portant les balises ; pied de page de paraphes si activé.
2. SHA-256 du PDF stocké sur `contract_versions.pdf_sha256` **avant**
   l'envoi, PDF stocké dans MinIO.
3. `createSubmission({ pdf, pdfSha256, … })` : l'adaptateur **recalcule**
   l'empreinte et refuse d'envoyer un octet différent (`VALIDATION`).
4. `POST /submissions/pdf`. Le contrat ne passe `PENDING_SIGNATURE` qu'au
   retour (EC-04).

Le document signé est ainsi le dérivé exact du document dont l'empreinte est
stockée (voir §8).

### 2.2 Voie secondaire — modèles figés DocuSeal

`createSubmissionFromTemplate({ providerTemplateId, submitters[].fields … })`
→ `POST /submissions`. Réservée aux documents **standard** gérés comme
modèles figés dans DocuSeal (mandat SEPA type, PV de recette…). Le
pré-remplissage utilise `fields[].default_value` **avec `readonly: true`**
pour toute valeur contractuelle : sans `readonly` côté serveur, la valeur
est modifiable depuis les outils de développement du navigateur. Un champ
inexistant dans le modèle provoque un 422 « Unknown field ».

## 3. Balises textuelles et gabarit

Module pur `packages/domain/src/signature/text-tags.ts`.

| Helper | Produit (rôle « Client ») |
|---|---|
| `signatureTag(role)` | `{{Signature Client;role=Client;type=signature;width=180;height=60}}` |
| `signingDateTag(role)` | `{{Date Client;role=Client;type=datenow;format=DD/MM/YYYY;width=90;height=18}}` |
| `initialsTag(role, 3)` | `{{Paraphe Client p3;role=Client;type=initials;width=48;height=24}}` |
| `initialsFooterHtml(roles)` | pied de page : un paraphe par rôle, numéro de page `<span class="pageNumber">` |
| `hiddenTagHtml(tag)` | `<span class="ds-tag" style="color:#ffffff;font-size:6pt;…;white-space:nowrap;">…</span>` |
| `signerRoleLabel(party)` | `Client` / `LSI Maintenance` — **source unique** balise ↔ `submitters[].role` |

### 3.1 Règles

- **Le rôle apparie la balise au signataire.** Même libellé dans le PDF et
  dans `submitters[].role`, sinon le signataire n'a aucun champ.
- **Noms distincts** : le nom de champ inclut le rôle (et la page pour le
  paraphe) ; aucun champ n'est partagé entre signataires.
- **`datenow` et non `date`** : la date est posée à la signature et n'est pas
  modifiable — un champ `date` laisserait antidater.
- **Anti-injection** : rôle, nom et format sont validés (`[\p{L}\p{N} ._'’-]`,
  64 car. max). `;`, `=`, `{`, `}` (grammaire de la balise) et `<>&"` sont
  refusés : un rôle `Client;readonly=true` ne peut pas ajouter d'attribut.
- **Taille** fixée par `width`/`height`, pas par la taille du texte.

### 3.2 Placement dans le gabarit (texte blanc)

Les balises sont écrites **en blanc, corps 6 pt, insécables** :

- le PDF figé archivé reste lisible (pas de `{{…}}` visibles) ;
- DocuSeal lit le **texte** du PDF, la couleur est sans effet sur la
  détection ; il retire ensuite les balises du document signé (`remove_tags`
  vrai par défaut) ;
- `white-space:nowrap` est indispensable : une balise coupée en fin de ligne
  n'est plus reconnue ;
- le champ se dessine à la position de la balise : le bloc de signature
  réserve la hauteur (`<div style="height:64px">`).

Bloc de signature (fin du document, `page-break-inside:avoid`) : pour chaque
signataire, nom, `Signature :` + balise signature, `Date de signature :` +
balise `datenow`.

### 3.3 Paraphe de chaque page (pied de page)

`initialsFooterHtml` est transmis au moteur comme `RenderRequest.footerHtml`
(Gotenberg : fichier `footer.html`, répété par Chromium sur chaque page, styles
en ligne obligatoires). Chromium remplace `<span class="pageNumber">` **dans**
la balise : le texte de la page 3 devient
`{{Paraphe Client p3;role=Client;type=initials;…}}`, soit un champ
obligatoire distinct par page et par rôle.

**Activé par `DOCUSEAL_INITIALS_FOOTER=true`, désactivé par défaut** : que
DocuSeal lise la balise reconstituée d'un seul tenant dans le texte du pied de
page ne se vérifie qu'en réel. Le test d'intégration
`balises textuelles du gabarit (instance réelle)` le contrôle (champs
`initials:Paraphe Client p1`, `p2`…) : l'activer en production après son
succès. En cas d'échec, repli : balises de paraphe dans le corps, page par page
(`initialsTag(role, n)`), au prix d'une mise en page à pages fixes.

## 4. Ordre des signataires et options

`SigningOrderPolicy` (domaine, `planSigningOrder`) :

| Politique | Effet DocuSeal |
|---|---|
| `CLIENT_THEN_LSI` — **défaut du brief** | `order: preserved`, clients 0…n, LSI ensuite : LSI ne contresigne qu'une fois l'accord du client acquis |
| `LSI_THEN_CLIENT` | règle historique RM-13 |
| `PARALLEL` | `order: random`, tous invités d'emblée |
| `AS_DEFINED` | ordre saisi sur le contrat (bloc Signataires) ; ex-æquo = groupe parallèle |

Rétrocompatibilité : un appelant qui passe `order: 'preserved'` sans politique
obtient `AS_DEFINED` (c'est le cas actuel de l'envoi, qui respecte le
`signingOrder` des signataires du contrat). Pour appliquer le défaut du brief,
passer `signingOrder: 'CLIENT_THEN_LSI'` (ou la valeur paramétrée du tenant).

Autres options : `expireAt` (défaut 30 jours, format DocuSeal
`YYYY-MM-DD HH:MM:SS UTC`), `subject`/`body` (variable `{{submitter.link}}`),
`completedRedirectUrl` (constante serveur, jamais une entrée utilisateur :
open redirect), `requireEmail2fa` (vrai côté client), `reminders`
(`ReminderPolicy`, **consommée par notre planificateur** : l'API n'a pas de
relance programmée ; une relance = `PUT /submitters/{id}` `send_email: true`).

## 5. E-mail ou signature intégrée

| Mode | Paramètres | Parcours |
|---|---|---|
| `delivery: 'EMAIL'` (défaut) | `send_email: true` | DocuSeal envoie le lien ; en ordre `preserved`, le signataire suivant n'est invité qu'après le précédent |
| `delivery: 'EMBEDDED'` | `send_email: false` (forcé) | l'application affiche le formulaire : `ProviderSubmission.submitters[].embedSrc` (`embed_src`, `https://<hôte>/s/<slug>`) dans le composant web `<docuseal-form data-src="…">` (script `https://cdn.docuseal.com/js/form.js`, à auto-héberger : aucune dépendance CDN en production) ou redirection vers l'URL |

En mode intégré, **c'est l'application qui authentifie** le signataire (session
portail, lien magique) avant de lui montrer `embed_src` : l'URL du formulaire
suffit à signer, elle ne doit jamais être exposée à un tiers. Le portail
existant construit déjà l'URL depuis le `slug` (`DOCUSEAL_SIGN_URL`).

## 6. Webhooks

### 6.1 Chaîne de traitement (`DocusealWebhookService`)

1. **HMAC** sur le corps brut (`X-Docuseal-Signature: <ts>.<hex>`,
   `HMAC_SHA256(secret, "<ts>.<corps>")`, ±5 min) — obligatoire,
   `DOCUSEAL_WEBHOOK_SECRET`, fail-closed.
2. **Secret partagé optionnel** (§6.2).
3. Parsing → événement normalisé (`form.*` : submission = `data.submission_id` ;
   `submission.*` : submission = `data.id`).
4. `process()` : scope résolu **depuis notre base** (`provider_submission_id`),
   jamais depuis le payload ; `metadata.tenant_id` n'est qu'une sonde de
   divergence.
5. **Idempotence** : `signature_events.provider_event_id` UNIQUE ; identifiant
   déterministe `docuseal:<type>:<submission>:<submitter>:<timestamp>`.
6. Effet métier, puis capture de preuve **enfilée après commit** (BullMQ,
   worker).

Réponses : 401 si authentification invalide ; 200 pour tout événement
authentifié, même non traitable (`unknown_submission`, `duplicate_ignored`,
`closed_ignored`) — DocuSeal réessaie 48 h sur 4xx/5xx, un réessai inutile
n'est que du bruit.

L'effet métier est appliqué **dans la requête**, en une transaction courte ;
seul le téléchargement des preuves passe par la file. Écart assumé avec « mis
en file dans le worker » du brief : l'effet est idempotent et rapide, et le
rejeu DocuSeal couvre un échec transitoire. Le passage en file complète est
possible sans changer `process()`.

### 6.2 Secret partagé d'en-tête

`DOCUSEAL_WEBHOOK_HEADER_SECRET` (+ `DOCUSEAL_WEBHOOK_HEADER_NAME`, défaut
`x-docuseal-webhook-secret`) : s'il est défini, l'en-tête doit le porter
**en plus** du HMAC (comparaison à temps constant). Défense en profondeur : la
fuite du seul secret HMAC ne suffit plus. Configuration : DocuSeal → Settings →
Webhooks → secret/en-tête personnalisé (à confirmer sur la version installée ;
à défaut, laisser la variable vide, le HMAC suffit — V2-H6).

### 6.3 Rejeu et désordre

DocuSeal ne garantit ni l'unicité ni l'ordre. Tous les effets sont
**monotones** :

| Situation | Comportement |
|---|---|
| même corps livré 2 fois | `duplicate_ignored`, un seul `signature_event` |
| `form.completed` réémis (autre horodatage) | journalisé ; signataire déjà `SIGNED` → aucun effet, `signed_at` préservé |
| `form.viewed` après signature | `SENT → VIEWED` seulement ; un `SIGNED` ne régresse pas |
| `form.declined` d'un signataire qui a signé | ignoré (journalisé) |
| `submission.completed` avant les `form.completed` | **autoritaire** : tous les signataires `SIGNED`, demande `COMPLETED`, contrat `SIGNED`, capture enfilée ; les `form.*` suivants → `closed_ignored` |
| événement sur demande close (`COMPLETED, DECLINED, EXPIRED, REVOKED, FAILED`) | `closed_ignored` |

Couverture : `tests/isolation/docuseal-webhook-ordering.test.ts` (fixtures
`webhook-sequence.*.json`).

## 7. Preuves et réconciliation

### 7.1 Capture (`ProofCaptureService`, job `capture-proof`)

À la complétion : `downloadCompletedDocuments()` =
`GET /submissions/{id}` (statut `completed` exigé, sinon `NOT_READY`
réessayable) + `GET /submissions/{id}/documents?merge=true` + téléchargement
des octets : PDF fusionné, chaque document, `audit_log_url`,
`combined_document_url` s'il existe. Contrôles : schéma http(s), en-tête
`%PDF-`, **pas de jeton** vers ces URL. Copie immédiate dans MinIO
(`t/{tenant}/c/{client}/contracts/{contrat}/signed/{demande}/document.pdf`,
`audit-trail.pdf`) avec SHA-256. **Aucune URL DocuSeal n'est conservée** :
l'obligation de preuve dure au-delà de la vie du fournisseur.

### 7.2 Réconciliation

- Preuves : `ReconciliationService` (horaire) réenfile les captures
  manquantes (`app_find_signatures_needing_proof`).
- Statuts : `DocusealWebhookService.reconcileFromProvider(id)` relit
  `GET /submissions/{id}`, traduit l'état en événements normalisés
  (`docuseal:reconcile:…`) passés par `process()` — mêmes gardes, même
  journal, idempotent. **Reste à brancher** : la découverte des demandes
  `SENT`/`PARTIALLY_COMPLETED` sans synchronisation récente, qui exige une
  fonction SQL bornée `app_find_signatures_needing_sync(stale_after, limit)`
  (migration du lot schéma), puis un job répété dans `SignatureWorkerService`.

## 8. Empreintes : envoyé ↔ signé

DocuSeal réécrit le PDF (champs dessinés, balises retirées, scellement) : le
SHA-256 du document signé **diffère toujours** de celui du document envoyé.
Isoler « le document hors surcouche » exigerait d'interpréter la structure
PDF — fragile, sans gain probatoire. Politique (`linkDocumentHashes`, pur) :

- on **conserve les deux** empreintes ;
- `relation = 'IDENTICAL'` si égales (anormal pour un document signé, à
  surveiller), `'SIGNED_OVERLAY'` sinon ;
- le lien probatoire est la chaîne : empreinte envoyée stockée **avant**
  l'envoi → revérifiée par l'adaptateur au moment de l'envoi → submission
  DocuSeal → PDF signé et journal d'audit rapatriés et hachés.

Aujourd'hui calculé et journalisé à la capture. Colonnes à ajouter
(lot schéma) : `signature_requests.sent_pdf_sha256`,
`signature_requests.hash_relation` (`IDENTICAL | SIGNED_OVERLAY`),
`signature_requests.audit_trail_sha256`, `signature_requests.mode`
(`PDF | TEMPLATE`), `signature_requests.delivery` (`EMAIL | EMBEDDED`).

## 9. Disponibilité et mode dégradé

`DocusealReadiness` : sonde `checkReadiness()` au démarrage (non bloquante) et
à la demande, cache `DOCUSEAL_READINESS_TTL_MS` (60 s), déduplication.
`/health/ready` (futur `/readyz`) expose
`checks.docuseal {available, reachable, tokenValid, detail, checkedAt}` **sans**
passer en 503 : DocuSeal en panne n'empêche pas de consulter ses contrats.
Le flag `contrats.docuseal.enabled` s'applique via
`effectiveDocusealEnabled(flagTenant, readiness.snapshot())` : neutralisé tant
que la sonde n'a pas confirmé la disponibilité ; l'interface affiche le
`detail`.

Erreurs typées de l'adaptateur :

| Cas | Erreur | Réessai |
|---|---|---|
| 401/403, clé absente | `ProviderAuthError` (`AUTH`) | non — alerter, faire tourner la clé |
| 400/422 | `ProviderValidationError` (`VALIDATION`, message DocuSeal) | non |
| 404 | `NOT_FOUND` | non |
| délai (`DOCUSEAL_TIMEOUT_MS`) | `ProviderTimeoutError` (`TIMEOUT`) | oui, **après** `findSubmissionByExternalId` |
| réseau, 429, 5xx | `ProviderUnavailableError` | oui |

## 10. eIDAS

La signature DocuSeal (tracé ou saisie, e-mail + OTP facultatif, journal
d'audit, scellement du PDF par le certificat de l'instance) relève **a priori
de la signature électronique simple (SES)** au sens du règlement (UE)
n° 910/2014 : elle n'est pas liée au signataire de manière univoque par un
certificat qualifié, et l'identité n'est pas vérifiée au-delà de la maîtrise
d'une adresse e-mail. En droit français (C. civ. art. 1366-1367), une SES est
recevable ; sa fiabilité doit être **prouvée** par qui s'en prévaut (d'où la
conservation des preuves, §7) — la présomption de fiabilité est réservée à la
signature **qualifiée** (décret n° 2017-1416).

Suffisante pour le cœur de cible (contrats de services B2B TPE-PME). Une
signature **avancée (AES)** ou **qualifiée (QES)** est à envisager :

- contrats à fort enjeu (montant, durée, pénalités), clients grands comptes
  ou publics dont la politique d'achat l'exige ;
- secteurs réglementés (santé — hébergement de données de santé —, finance,
  assurance), actes pour lesquels un texte impose un niveau ;
- contrats avec **consommateurs** sujets à contestation, ou contreparties
  étrangères où la reconnaissance transfrontière compte (seule la QES a
  l'effet d'une signature manuscrite dans toute l'UE, art. 25).

Ce qu'il faudrait changer :

1. **Prestataire** : un PSCo (prestataire de services de confiance)
   **qualifié**, inscrit sur la liste de confiance de l'UE (EU Trust List,
   ANSSI pour la France), fournissant certificats de signature et
   horodatage qualifiés.
2. **Second adaptateur** derrière `ESignatureProvider` (aucun changement du
   domaine) ; `ProviderName` étendu ; choix du provider par contrat ou par
   tenant (colonne `signature_requests.provider` déjà présente).
3. **Vérification d'identité** du signataire (pièce d'identité + vidéo ou
   autre moyen conforme, eIDAS niveau substantiel/élevé) — hors DocuSeal.
4. **Horodatage qualifié RFC 3161** du document signé : la colonne
   `signature_requests.timestamp_token` existe déjà, non alimentée.
5. Format **PAdES** (B-LT/B-LTA) pour la validation à long terme, et
   conservation des éléments de validation (chaînes de certificats, OCSP/CRL).

## 11. Configuration

| Variable | Rôle | Défaut |
|---|---|---|
| `DOCUSEAL_URL` | base API (`…/api`) | `http://docuseal:3000/api` |
| `DOCUSEAL_API_KEY` | jeton `X-Auth-Token` (secret) | — |
| `DOCUSEAL_TIMEOUT_MS` | délai des appels | 30000 |
| `DOCUSEAL_READINESS_TIMEOUT_MS` / `_TTL_MS` | sonde / cache | 5000 / 60000 |
| `DOCUSEAL_WEBHOOK_SECRET` | secret HMAC (obligatoire) | — |
| `DOCUSEAL_SIGNATURE_HEADER` | en-tête HMAC | `x-docuseal-signature` |
| `DOCUSEAL_WEBHOOK_HEADER_SECRET` / `_NAME` | secret d'en-tête additionnel | vide / `x-docuseal-webhook-secret` |
| `DOCUSEAL_INITIALS_FOOTER` | paraphe par page | `false` |
| `DOCUSEAL_SIGN_URL` | base publique des liens `/s/<slug>` (portail) | dérivée de `DOCUSEAL_URL` |

## 12. Tests

- Domaine : `packages/domain/tests/docuseal-signature-helpers.test.ts`
  (balises, ordre, empreintes, erreurs).
- Adaptateur sans réseau : `apps/api/tests/unit/docuseal-adapter.test.ts`
  (fixtures, `fetch` simulé ; toute requête non prévue échoue).
- Webhooks bout en bout : `docuseal-webhook.test.ts`,
  `docuseal-webhook-ordering.test.ts` ; disponibilité :
  `docuseal-readiness.test.ts`.
- Instance réelle (ignorés si absente) :
  `tests/integration/docuseal-ee.integration.test.ts`.
