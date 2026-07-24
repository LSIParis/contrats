# Enregistrer un contrat existant (import manuel) — design

**Date** : 2026-07-24
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : permettre d'**enregistrer manuellement un contrat déjà existant**
(signé hors application, ou en cours mais géré ailleurs) directement en état
`ACTIVE`, avec ses métadonnées et son document joint, pour bénéficier du
**registre, du journal d'audit et des rappels d'échéance/renouvellement** —
sans passer par le flux DRAFT → signature et sans re-signature.

## 1. Objectif et constat

Aujourd'hui un contrat **démarre toujours en `DRAFT`** (`POST /v1/contracts`)
puis suit la machine à états jusqu'à `SIGNED`/`ACTIVE` via DocuSeal. Il n'existe
**aucun moyen** d'enregistrer un contrat déjà signé/actif ailleurs sans le
refaire passer par tout le flux. C'est le manque à combler.

Décisions de cadrage (déjà tranchées) : **saisie manuelle, un par un**
(pas d'import Excel/CSV en masse) ; **contrats actifs seulement**
(état `ACTIVE`, pas d'historique échu) ; objectif **suivi + rappels seulement**
(pas de ré-édition ni re-signature). Les formes concernées (PDF signés,
Word/éditable) sont toutes **enregistrées avec le fichier joint**, pas éditées.

## 2. Décisions

| Sujet | Décision |
|---|---|
| État d'entrée | Le contrat est créé **directement en `ACTIVE`** (données d'un fait existant, pas une transition de workflow). Il suit ensuite le cycle de fin de vie normal (expiration/renouvellement/résiliation). |
| Origine | Nouveau champ **`origin`** sur `Contract` : `NATIVE` (défaut, contrats créés dans l'app) / `IMPORTED`. Un importé est **toujours distinguable** d'un contrat signé dans l'app. |
| Document joint | Upload d'**un** fichier (PDF ou DOCX) stocké dans **S3/MinIO scopé** (`DOCUMENT_STORAGE` + `assertKeyMatchesScope`, préfixe `t/{tenant}/c/{customer}/…`). Rattaché au contrat (clé + nom d'origine + sha256 + type MIME). |
| Preuve | **Aucune preuve cryptographique DocuSeal** — c'est un document importé, affiché « signé hors application ». Ne jamais le présenter comme une signature électronique de l'app. |
| Métadonnées | client (doit exister, vérifié au scope → 404), référence (unicité `@@unique(tenantId, reference)` → 409), titre, type (`MAIN`/`AMENDMENT`), catégorie, date de début, date de fin, préavis (jours), montant (centimes), date de signature réelle (`signedAt`, optionnelle). |
| Rappels | Alimentés par `endDate`/préavis existants : un contrat `ACTIVE` avec `endDate` est pris automatiquement par le dispatch de rappels (aucun câblage spécifique). |
| Contenu | **Pas de contenu HTML éditable, pas de version, pas de flux DocuSeal.** `currentVersionId` reste nul ; l'édition de contenu et l'envoi en signature ne s'appliquent pas à un importé. |
| Rôles | `assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])` (mêmes rôles que la création de contrat). |
| Audit | L'`AuditInterceptor` global trace déjà les mutations réussies → l'import est **audité automatiquement** (« contrat importé »). |
| Upload | Premier upload multipart de l'app : `FileInterceptor` (`@nestjs/platform-express`, déjà présent ; multer en mémoire). Limite de taille (p.ex. 20 Mo) ; types autorisés `application/pdf` et le MIME DOCX. |

## 3. Backend

### 3.1 Migration
- Ajouter à `contracts` : `origin` (`'NATIVE'`/`'IMPORTED'`, défaut `'NATIVE'` — les lignes existantes deviennent `NATIVE`), et les champs du document importé : `imported_document_key`, `imported_document_name`, `imported_document_sha256` (Char(64)), `imported_document_content_type` (tous nullable). *(Le plan tranche : champs sur `contracts` vs petite table dédiée ; MVP = champs sur `contracts`.)*
- Forward-only, compatible RLS (la policy `contracts` existante s'applique inchangée aux nouvelles colonnes).

### 3.2 Endpoint
- `POST /v1/contracts/import` — **multipart/form-data** : un champ fichier (`document`) + les métadonnées en **champs texte du même form-data** (validées par un DTO `class-validator` avec transformation des types : les nombres/dates arrivent en chaîne), `assertRole(['MSP_ADMIN','ACCOUNT_MANAGER'])`.
  - Valide le fichier (présent, type PDF/DOCX, taille ≤ limite) et les métadonnées (DTO `class-validator`).
  - Vérifie le client au scope (404 si hors portefeuille) et l'unicité de `reference` (409).
  - Stocke le document (`DOCUMENT_STORAGE.put`, clé scopée `t/{tenant}/c/{customer}/imported/{contractId}.{ext}`, `assertKeyMatchesScope`), calcule le sha256.
  - Crée la ligne `contracts` **directement** : `status='ACTIVE'`, `origin='IMPORTED'`, `activatedAt=now` (ou `startDate`), `startDate`/`endDate`/`noticePeriodDays`/`amountCents`/`reference`/`title`/`type`/`category`/`signedAt`, `currentVersionId=null`, + champs document.
  - Renvoie `{ id }`.
- `GET /v1/contracts/:id/imported-document` — télécharge le document importé (stream ou URL présignée courte, scopé/RLS → 404 hors scope), `Content-Disposition: attachment` (nom d'origine slugifié).

### 3.3 Service
- Méthode dédiée (`ContractsService.importContract` ou petit `ContractImportService`) : orchestре upload + insertion `ACTIVE/IMPORTED` sous `withScope`. Ne passe **pas** par la machine à états (c'est une création). Les transitions futures depuis `ACTIVE` restent gouvernées par la machine.

## 4. Frontend

- **Formulaire « Importer un contrat existant »** (nouvelle page/route ou modale depuis la liste des contrats) : sélection du client (liste des clients existants), référence, titre, type, catégorie, date de début, date de fin, préavis, montant, **upload du fichier**. Submit → `POST /v1/contracts/import` (multipart). Erreurs surfacées (409 référence en double, 404 client, 400 fichier invalide).
- **Fiche contrat** (`contract-detail-page.tsx`) : si `origin === 'IMPORTED'`, afficher un **badge « Importé »** et un bloc **« Document importé (signé hors application) »** avec lien de téléchargement (`/v1/contracts/:id/imported-document`). Le bloc/panneau de signature affiche « signé hors application » au lieu d'une preuve DocuSeal, et masque l'édition de contenu / l'envoi en signature (non applicables à un importé).

## 5. Sécurité et tests

- **Sécurité** : rôle-gardé ; client vérifié au scope (404) ; référence unique (409) ; document scopé (`assertKeyMatchesScope`, préfixe tenant/client) ; type/taille de fichier validés ; audité automatiquement ; un importé n'affiche **jamais** de preuve de signature de l'app.
- **Tests API** (isolation ; `DOCUMENT_STORAGE` = `InMemoryStorage` en test) :
  - Import → **201** ; le contrat existe en `status='ACTIVE'`, `origin='IMPORTED'`, dates/montant/référence corrects, document stocké et récupérable via `GET …/imported-document` (200, bon Content-Type).
  - **403** hors MSP_ADMIN/ACCOUNT_MANAGER ; **404** si le client n'est pas dans le scope ; **409** référence en double ; **400** fichier absent/type invalide.
  - Un contrat importé **n'apparaît pas** comme éditable/signable (pas de version courante) ; `GET …/imported-document` d'un autre tenant → 404.
  - (Rappels) un importé `ACTIVE` avec `endDate` proche est bien candidat au dispatch de rappels (au moins un test de la requête de sélection, si praticable).
- **Front** : formulaire d'import (validation, upload) ; badge « Importé » + lien document sur la fiche.
- **Gates CI** : `pnpm lint && pnpm typecheck` (repo-wide) avant merge.

## 6. Non-objectifs (différés)

- Import en masse **Excel/CSV** (+ rattachement par lot).
- Contrats **échus/historiques** (EXPIRED/TERMINATED) — actifs seulement.
- **Ré-édition / re-signature** d'un contrat importé dans l'app.
- **OCR / extraction automatique** des métadonnées depuis le PDF.
- **Création du client à la volée** (le client doit exister au préalable).
- Import de plusieurs documents / pièces jointes multiples par contrat (un seul document au MVP).
