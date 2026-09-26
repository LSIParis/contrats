# 03 — Reprise des contrats existants (scans PDF)

> Brief §3. Les contrats déjà signés hors plateforme sont **valides de plein
> droit** : aucune signature n'est redemandée. L'application en conserve la
> preuve, en extrait les métadonnées et ne les rend opposables qu'après
> **validation humaine**.

## 1. Parcours

```
dépôt PDF (unitaire / lot)          ──► contrat IMPORTED_PENDING_VALIDATION
  │  SHA-256 calculé à la réception      origin = IMPORTED (API : LEGACY_IMPORT)
  │  StoredDocument LEGACY_SCAN          signatureMode = EXTERNAL_WET_SIGNATURE
  ▼
job « import.ocr » (worker)
  │  ocrmypdf + tesseract fra (conteneur `ocr`, réseau interne)
  │  → StoredDocument OCR_PDF + OCR_TEXT (derived_from = original)
  ▼
extraction locale (règles, @lsi/domain extractContractMetadata)
  │  + extraction LLM OPTIONNELLE (flag contrats.ai.enabled, texte pseudonymisé)
  ▼
écran de validation côte à côte (PDF | champs + score de confiance)
  │  rôle imports.validate (juriste/valideur, admin)
  ▼
VALIDATE_IMPORT → ACTIVE (ou SIGNED si effet futur, EXPIRED si terme passé)
  + période INITIALE, échéances (Deadline), rappels
  + barème (saisie ou contrat type) — lot 3
```

## 2. Valeur probante

| Exigence | Réalisation |
|---|---|
| Original conservé tel quel, jamais modifié | Objet S3 sous `t/{tenant}/c/{client}/imports/{id}/original.pdf`, bucket versionné ; ligne `stored_documents` (kind `LEGACY_SCAN`) en **écriture unique** : UPDATE/DELETE révoqués au rôle applicatif (migration 17). Aucune route de remplacement. |
| Empreinte | SHA-256 calculée **à la réception, avant toute transformation**, stockée sur `stored_documents.sha256` (et `contracts.imported_document_sha256`, historique). |
| Horodatage, identité de l'importateur | `stored_documents.created_at`, `uploaded_by_user_id` ; entrée d'audit chaînée `POST /v1/contracts/import` ; transition `→ IMPORTED_PENDING_VALIDATION` dans `lifecycle_events`. |
| Copie texte distincte de l'original | `OCR_PDF` et `OCR_TEXT` sont des documents **dérivés** (`derived_from_id` → original), jamais substitués à lui. Le téléchargement « document source » sert toujours l'original. |
| Validation humaine obligatoire | Aucun contrat importé ne devient `ACTIVE` sans `VALIDATE_IMPORT` (garde du domaine + rôle `imports.validate`). L'utilisateur qui importe (commercial) n'est pas celui qui valide (valideur) : séparation des tâches par la matrice de rôles. |
| Traçabilité de l'extraction | `contract_imports.extraction` conserve chaque champ proposé (valeur, confiance, extrait source, méthode) ; `validated_fields` conserve ce qui a été retenu et par qui. L'écart proposé / retenu est donc auditable. |

**Limite assumée** : un scan est une copie. La valeur probante d'un contrat
papier numérisé repose sur la fidélité de la copie (art. 1379 C. civ. :
copie fiable = présomption de fiabilité si conditions du décret n° 2016-1673,
notamment empreinte et horodatage). L'application fournit empreinte,
horodatage, journal d'audit chaîné et conservation de l'original numérique
reçu ; elle ne remplace pas la conservation de l'original papier, qui reste
recommandée. **Point à valider par un juriste.**

## 3. OCR

- Service `ocr` (`deploy/ocr/`) : `POST /ocr` (PDF brut) → `{ text, pages, pdfBase64 }`.
  `ocrmypdf --skip-text -l fra --sidecar` : un PDF déjà textuel n'est pas
  re-rasterisé.
- Joignable **uniquement** sur le réseau interne de la stack ; aucun appel
  sortant. Le contenu des documents n'est jamais journalisé.
- Exécuté par le worker (job `import.ocr`, 3 tentatives, backoff
  exponentiel). En échec définitif, l'import reste validable à la main
  (`ocrStatus = FAILED`, message affiché) : l'OCR aide, il ne bloque pas.
- Client : `apps/api/src/imports/ocr.client.ts`, testé sur fixtures
  `test/fixtures/ocr/`.

## 4. Extraction

1. **Règles locales** (`packages/domain/src/import-extraction/`) : parties,
   SIREN, date de signature, date d'effet, durée, reconduction, préavis,
   montants, indice de révision. Chaque champ : `{ value, confidence 0..1,
   evidence: { excerpt, offset } }`.
2. **LLM (optionnel)** : uniquement si `contrats.ai.enabled` ; le texte est
   **pseudonymisé** (`pseudonymize`, garde `assertNoLeak`) avant envoi ; la
   réponse est validée par Zod puis réidentifiée localement. Les champs LLM
   ne remplacent jamais un champ « règles » de confiance supérieure.
3. Le résultat est une **proposition**. Rien n'est écrit sur le contrat avant
   la validation.

## 5. API

| Méthode | Route | Rôle | Effet |
|---|---|---|---|
| `POST` | `/v1/contracts/import` | `contracts.import` | Dépôt unitaire (multipart : `document` + métadonnées facultatives) → contrat `IMPORTED_PENDING_VALIDATION` |
| `POST` | `/v1/contracts/import/batch` | `contracts.import` | Dépôt par lot (jusqu'à 20 PDF, un client) → un contrat par fichier |
| `GET` | `/v1/contracts/:id/import` | lecture | Extraction, statut OCR, liens original / PDF OCR |
| `GET` | `/v1/contracts/:id/import/ocr.pdf` | lecture | PDF recherchable (copie de travail) |
| `POST` | `/v1/contracts/:id/import/validate` | `imports.validate` | Validation des champs → `VALIDATE_IMPORT` |
| `POST` | `/v1/contracts/:id/import/retry-ocr` | `contracts.import` | Relance de l'OCR |

Le contrat importé expose `origin = LEGACY_IMPORT` et
`signatureMode = EXTERNAL_WET_SIGNATURE` dans l'API publique (`07-api.md`)
et un bandeau explicite dans l'interface.
