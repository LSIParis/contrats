# Service OCR interne (`ocr`)

`ocrmypdf` + Tesseract (`fra`) derrière un mini-serveur HTTP Python
(bibliothèque standard uniquement). Joignable **uniquement** sur le réseau
interne de la stack : `http://ocr:8080`. Jamais publié, aucune donnée ne sort
du VPS.

## API

| Requête | Réponse |
|---|---|
| `GET /health` | `200 {"status":"ok"}` |
| `POST /ocr`, corps `application/pdf` (`Content-Length` obligatoire) | `200 {"text": "...", "pages": N, "pdfBase64": "<PDF recherchable>"}` |

`text` : pages séparées par un saut de page (`\f`). Les pages qui portaient
déjà du texte ne sont pas ré-océrisées (`--skip-text`) ; leur texte est extrait
du PDF de sortie. Le PDF renvoyé est une **copie de travail** : l'original
déposé et son SHA-256 restent la seule référence probante (côté application).

Erreurs : `{"error": "<code>", "detail": "<message>"}`

| Statut | `error` | Cause |
|---|---|---|
| 400 | `invalid_pdf`, `empty_body`, `incomplete_body`, `bad_request` | corps absent, tronqué ou non PDF |
| 404 | `not_found` | route inconnue |
| 411 | `length_required` | `Content-Length` absent (pas de `chunked`) |
| 413 | `payload_too_large` | PDF > `OCR_MAX_BYTES` |
| 415 | `unsupported_media_type` | `Content-Type` ≠ `application/pdf` |
| 422 | `encrypted_pdf`, `invalid_pdf` | PDF chiffré ou illisible (codes 8 et 2 d'ocrmypdf) |
| 500 | `ocr_failed`, `ocr_unavailable`, `text_extraction_failed`, `internal_error` | échec interne |
| 503 | `busy` (+ `Retry-After: 10`) | plus de `OCR_MAX_CONCURRENCY` OCR en cours |
| 504 | `ocr_timeout` | OCR plus long que `OCR_TIMEOUT_SECONDS` |

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `OCR_PORT` | `8080` | port d'écoute |
| `OCR_MAX_BYTES` | `52428800` (50 Mo) | taille maximale du PDF |
| `OCR_TIMEOUT_SECONDS` | `300` | délai maximal d'un OCR |
| `OCR_LANG` | `fra` | langues Tesseract (`fra+eng` possible si le modèle est installé) |
| `OCR_JOBS` | `1` | parallélisme interne d'ocrmypdf par requête |
| `OCR_MAX_CONCURRENCY` | `2` | requêtes OCR simultanées |

## Sécurité

- utilisateur `ocr` (uid 10001), non root ; la stack le lance en système de
  fichiers **en lecture seule** avec `/tmp` en `tmpfs`, `cap_drop: ALL`,
  `no-new-privileges` ;
- chaque requête travaille dans un répertoire temporaire supprimé en sortie ;
- `subprocess.run` sans shell, arguments en liste ;
- **aucun contenu de document dans les logs** : seule une ligne d'accès
  (méthode, chemin, statut, taille, durée). La sortie d'erreur d'ocrmypdf est
  capturée et jamais journalisée (elle peut citer le document).

## Tests (hors suite Node)

Les tests remplacent `subprocess.run` par un faux : aucun OCR réel, aucun
binaire requis, Python ≥ 3.10.

```sh
cd deploy/ocr
python -m unittest -v
```

Dans l'image (Python et pikepdf de Debian) :

```sh
docker build -t contrats-ocr:local deploy/ocr
docker run --rm -v "$PWD/deploy/ocr:/t:ro" -w /t -e PYTHONDONTWRITEBYTECODE=1 contrats-ocr:local python3 -m unittest
```

## Essai manuel

```sh
docker run -d --name ocr --read-only --tmpfs /tmp --cap-drop ALL -p 127.0.0.1:18080:8080 contrats-ocr:local
curl -s -H 'Content-Type: application/pdf' --data-binary @scan.pdf http://127.0.0.1:18080/ocr | jq '.pages, (.text|.[0:200])'
```
