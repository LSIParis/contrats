# Sauvegardes Wasabi — Plan d'implémentation

> **For agentic workers:** implémentation infra (conteneur + scripts + CI + compose). Pas de TDD applicatif : la vérification est un **cycle réel** (dump + mirror vers Wasabi) puis un **test de restauration**. Steps en cases à cocher.

**Goal:** Sauvegardes quotidiennes hors-site et chiffrées de PostgreSQL + MinIO vers Wasabi, surveillées (Uptime Kuma) et restaurables.

**Architecture:** Une image `contrats-backup` (postgres:16-alpine + `mc` + `curl` + `supercronic`) construite par la CI, tirée depuis ghcr, lancée comme service de la stack `lsi-contrats` sur *Docker Legal* (ep5). `supercronic` déclenche `backup.sh` à 02h00 et `restore-check.sh` le 1er du mois.

**Tech Stack:** Docker, docker-compose (stack Portainer), `pg_dump`/`pg_restore` (PG 16), MinIO Client `mc`, `supercronic`, GitHub Actions (ghcr), Wasabi (S3 Paris eu-west-2, SSE + object lock), Uptime Kuma (push).

## Global Constraints

- **Dépôt PUBLIC** → aucun secret dans le dépôt. `WASABI_ACCESS_KEY`, `WASABI_SECRET_KEY`, `UPTIME_PUSH_URL`, `UPTIME_RESTORE_PUSH_URL` **uniquement** dans l'env de la stack Portainer. Les scripts ne lisent que des variables d'env.
- Destination fixe : `https://s3.eu-west-2.wasabisys.com`, bucket `lsi-contrats`, préfixes `pg/` et `minio/`. Chiffrement **SSE** (défaut du bucket, côté Wasabi). Object lock **déjà activé**.
- Source MinIO = bucket `lsi-contrats` via `S3_ACCESS_KEY`/`S3_SECRET_KEY` (env existant). PG via `POSTGRES_SUPERUSER_PASSWORD` (env existant).
- `mc mirror` **toujours additif** (jamais `--remove`). `set -e` dans les scripts : toute erreur ⇒ sortie non nulle **avant** le heartbeat ⇒ Uptime Kuma alerte.
- Base PG = `postgres:16-alpine` → `pg_dump`/`pg_restore` **v16** obligatoires (alignés).
- Réseau : la stack n'a pas de réseau nommé → le service `backup` joint le réseau par défaut et atteint `postgres:5432` / `minio:9000` par nom.
- **Aucune migration.**

---

## Structure de fichiers

- Create: `deploy/backup/Dockerfile`
- Create: `deploy/backup/entrypoint.sh` (configure les alias `mc`, exec supercronic)
- Create: `deploy/backup/crontab` (planification supercronic)
- Create: `deploy/backup/backup.sh` (dump + upload + mirror + heartbeat)
- Create: `deploy/backup/restore-check.sh` (restauration mensuelle dans une base jetable)
- Create: `deploy/backup/RESTORE.md` (runbook de restauration manuelle)
- Modify: `.github/workflows/ci.yml` (job `build-push-backup`)
- Modify: `deploy/docker-compose.stack.yml` (service `backup`)

---

## Task 1 : image + scripts de sauvegarde

**Files:** `deploy/backup/{Dockerfile,entrypoint.sh,crontab,backup.sh,restore-check.sh,RESTORE.md}`

**Interfaces:**
- Produces: image buildable depuis `deploy/backup/` exposant `backup.sh` et `restore-check.sh`, pilotée par `supercronic /etc/crontab`. Variables consommées : `PGHOST,PGDATABASE,PGUSER,PGPASSWORD,S3_BUCKET,S3_ACCESS_KEY,S3_SECRET_KEY,WASABI_ENDPOINT,WASABI_BUCKET,WASABI_ACCESS_KEY,WASABI_SECRET_KEY,UPTIME_PUSH_URL,UPTIME_RESTORE_PUSH_URL,TZ`.

- [ ] **Step 1 : `deploy/backup/Dockerfile`**

```dockerfile
FROM postgres:16-alpine

# mc (client MinIO/S3), curl, supercronic (cron pour conteneurs), bash, tzdata
ARG SUPERCRONIC_VERSION=v0.2.33
RUN apk add --no-cache curl bash tzdata \
 && curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc \
 && chmod +x /usr/local/bin/mc \
 && curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" -o /usr/local/bin/supercronic \
 && chmod +x /usr/local/bin/supercronic

COPY entrypoint.sh backup.sh restore-check.sh /usr/local/bin/
COPY crontab /etc/crontab
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/backup.sh /usr/local/bin/restore-check.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 2 : `deploy/backup/entrypoint.sh`**

```sh
#!/bin/sh
# Configure les alias mc depuis l'env, puis lance le planificateur.
# Fail-fast : si un secret manque, mc alias set échoue et le conteneur s'arrête
# (visible dans Portainer) plutôt que de tourner sans jamais sauvegarder.
set -eu

: "${WASABI_ENDPOINT:?}" "${WASABI_ACCESS_KEY:?}" "${WASABI_SECRET_KEY:?}" "${WASABI_BUCKET:?}"
: "${S3_ACCESS_KEY:?}" "${S3_SECRET_KEY:?}" "${S3_BUCKET:?}"

mc alias set local  "http://minio:9000"   "$S3_ACCESS_KEY"     "$S3_SECRET_KEY"
mc alias set wasabi "$WASABI_ENDPOINT"     "$WASABI_ACCESS_KEY" "$WASABI_SECRET_KEY"

echo "[backup] alias mc configurés ; planificateur démarré (backup 02h00, restore-check le 1er 03h00)"
exec supercronic /etc/crontab
```

- [ ] **Step 3 : `deploy/backup/crontab`**

```cron
# m h dom mon dow  commande      (TZ pris de l'env TZ=Europe/Paris)
0 2 * * *   /usr/local/bin/backup.sh
0 3 1 * *   /usr/local/bin/restore-check.sh
```

- [ ] **Step 4 : `deploy/backup/backup.sh`**

```sh
#!/bin/sh
# Un cycle : pg_dump -> Wasabi, mirror MinIO -> Wasabi, puis heartbeat.
# set -e : toute erreur sort non-zéro AVANT le heartbeat -> Uptime Kuma alerte.
set -eu

STAMP="$(date +%Y-%m-%dT%H%M)"
TMP="/tmp/lsi_${STAMP}.dump"

echo "[backup] pg_dump ${STAMP}..."
pg_dump -Fc -f "$TMP"            # PGHOST/PGUSER/PGPASSWORD/PGDATABASE via env

echo "[backup] upload pg -> wasabi/${WASABI_BUCKET}/pg/${STAMP}.dump"
mc cp "$TMP" "wasabi/${WASABI_BUCKET}/pg/${STAMP}.dump"
rm -f "$TMP"

echo "[backup] mirror minio (local/${S3_BUCKET}) -> wasabi/${WASABI_BUCKET}/minio/"
mc mirror --overwrite "local/${S3_BUCKET}" "wasabi/${WASABI_BUCKET}/minio/"

echo "[backup] succès -> heartbeat Uptime Kuma"
# Le heartbeat ne doit pas faire échouer la sauvegarde : garde || true.
if [ -n "${UPTIME_PUSH_URL:-}" ]; then
  curl -fsS -m 15 "${UPTIME_PUSH_URL}?status=up&msg=OK" >/dev/null 2>&1 || echo "[backup] warn: heartbeat KO"
fi
echo "[backup] terminé"
```

- [ ] **Step 5 : `deploy/backup/restore-check.sh`**

```sh
#!/bin/sh
# Vérification mensuelle : restaure le dernier dump dans une base JETABLE et
# compare quelques comptes au live. Prouve que le dump est exploitable.
set -eu

LATEST="$(mc ls "wasabi/${WASABI_BUCKET}/pg/" | awk '{print $NF}' | sort | tail -1)"
[ -n "$LATEST" ] || { echo "[restore-check] aucun dump trouvé"; exit 1; }
echo "[restore-check] dernier dump: ${LATEST}"

mc cp "wasabi/${WASABI_BUCKET}/pg/${LATEST}" /tmp/check.dump

psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS lsi_restore_check;"
psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE lsi_restore_check;"
# pg_restore peut émettre des warnings de rôles (--no-owner l'évite) ; on ne
# stoppe pas dessus, mais la comparaison de comptes ci-dessous fait foi.
pg_restore --no-owner --no-privileges -d lsi_restore_check /tmp/check.dump || true

LIVE="$(psql -tAc 'SELECT count(*) FROM contracts')"
REST="$(psql -d lsi_restore_check -tAc 'SELECT count(*) FROM contracts')"
echo "[restore-check] contracts live=${LIVE} restored=${REST}"

psql -v ON_ERROR_STOP=1 -c "DROP DATABASE lsi_restore_check;"
rm -f /tmp/check.dump

# Succès = la base restaurée a un compte cohérent (> 0 et = live).
if [ -n "$REST" ] && [ "$REST" = "$LIVE" ] && [ -n "${UPTIME_RESTORE_PUSH_URL:-}" ]; then
  curl -fsS -m 15 "${UPTIME_RESTORE_PUSH_URL}?status=up&msg=restore_ok_${REST}" >/dev/null 2>&1 || true
fi
```

- [ ] **Step 6 : `deploy/backup/RESTORE.md` (runbook)**

````markdown
# Restauration — LSI Contrats (sauvegardes Wasabi)

Sauvegardes : bucket Wasabi `lsi-contrats` (Paris), préfixes `pg/` (dumps
PostgreSQL) et `minio/` (miroir des PDF signés + audits). Chiffrées (SSE),
immuables (object lock).

## Pré-requis
Depuis un conteneur disposant de `mc` + `pg_restore` v16 (ex. le conteneur
`backup` de la stack) avec les alias `mc` `wasabi` et `local` configurés.

## 1. Restaurer PostgreSQL
```sh
# lister les dumps, prendre le voulu
mc ls wasabi/lsi-contrats/pg/
mc cp wasabi/lsi-contrats/pg/<AAAA-MM-JJThhmm>.dump /tmp/r.dump
# restaurer dans une base neuve puis basculer (NE PAS écraser le live à l'aveugle)
psql -c "CREATE DATABASE lsi_contrats_restored;"
pg_restore --no-owner --no-privileges -d lsi_contrats_restored /tmp/r.dump
# vérifier, puis renommer/basculer selon la procédure d'exploitation
```

## 2. Restaurer MinIO (PDF signés + audits)
```sh
# re-synchroniser depuis Wasabi vers MinIO (additif)
mc mirror --overwrite wasabi/lsi-contrats/minio/ local/lsi-contrats
```

## 3. Vérifier
- Comptes de lignes cohérents (`contracts`, `signature_requests`, `contract_versions`).
- Un `signed_pdf_object_key` connu se télécharge bien depuis MinIO.
````

- [ ] **Step 7 : Commit**

```bash
git add deploy/backup
git commit -m "feat(backup): image + scripts sauvegarde PG/MinIO vers Wasabi"
```

---

## Task 2 : CI — build & push de l'image `contrats-backup`

**Files:** Modify `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `deploy/backup/` (Task 1).
- Produces: image `ghcr.io/lsiparis/contrats-backup:{sha-*,latest}` publiée sur push `main`.

- [ ] **Step 1 : ajouter le job (après `build-and-push`)**

```yaml
  build-push-backup:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/lsiparis/contrats-backup
          tags: |
            type=sha,prefix=sha-
            type=raw,value=latest,enable={{is_default_branch}}
      - uses: docker/build-push-action@v6
        with:
          context: ./deploy/backup
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2 : Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build & push de l'image contrats-backup"
```

---

## Task 3 : service `backup` dans la stack

**Files:** Modify `deploy/docker-compose.stack.yml`

**Interfaces:**
- Consumes: image de Task 2.
- Produces: service `backup` joignant `postgres`/`minio`, planifié.

- [ ] **Step 1 : ajouter le service (après `api`, avant `volumes:`)**

```yaml
  backup:
    image: ghcr.io/lsiparis/contrats-backup:${IMAGE_TAG:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_healthy
    environment:
      TZ: Europe/Paris
      PGHOST: postgres
      PGDATABASE: lsi_contrats
      PGUSER: postgres
      PGPASSWORD: ${POSTGRES_SUPERUSER_PASSWORD}
      S3_BUCKET: ${S3_BUCKET}
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      WASABI_ENDPOINT: https://s3.eu-west-2.wasabisys.com
      WASABI_BUCKET: lsi-contrats
      WASABI_ACCESS_KEY: ${WASABI_ACCESS_KEY}
      WASABI_SECRET_KEY: ${WASABI_SECRET_KEY}
      UPTIME_PUSH_URL: ${UPTIME_PUSH_URL}
      UPTIME_RESTORE_PUSH_URL: ${UPTIME_RESTORE_PUSH_URL:-}
```

- [ ] **Step 2 : Commit**

```bash
git add deploy/docker-compose.stack.yml
git commit -m "deploy: service backup dans la stack lsi-contrats"
```

---

## Clôture — déploiement + validation réelle

- [ ] **Préparatifs Philippe (hors dépôt)** : (1) créer une **clé d'accès Wasabi** limitée au bucket `lsi-contrats` ; (2) créer **2 push monitors Uptime Kuma** (« backup », « backup-restore-check ») ; (3) s'assurer que le **chiffrement par défaut (SSE)** est activé sur le bucket ; (4) coller `WASABI_ACCESS_KEY`, `WASABI_SECRET_KEY`, `UPTIME_PUSH_URL`, `UPTIME_RESTORE_PUSH_URL` dans l'env de la stack Portainer.
- [ ] **Merge main** → CI (`test` + `build-and-push` + `build-push-backup`) verte → l'image `contrats-backup:latest` est publiée.
- [ ] **Redéploiement** (préserve l'env live + les nouveaux `WASABI_*`/`UPTIME_*`). Le service `backup` démarre ; vérifier dans les logs `alias mc configurés`.
- [ ] **Premier cycle à la main** : `docker exec` du conteneur `backup` → `backup.sh`. Vérifier : `mc ls wasabi/lsi-contrats/pg/` montre un dump, `mc ls wasabi/lsi-contrats/minio/` montre les objets, et le monitor Uptime « backup » passe **up**.
- [ ] **Test de restauration** : lancer `restore-check.sh` (ou dérouler `RESTORE.md`) → base jetable restaurée, comptes de lignes cohérents, `DROP` effectué.
- [ ] **Retention** : dans la console Wasabi, poser une **règle de cycle de vie 90 j** sur le préfixe `pg/` (bornée par l'object lock). *(Non automatisé dans le conteneur pour éviter les conflits avec l'object lock.)*
- [ ] **Note d'ops** : consigner en mémoire que les sauvegardes existent (cible, cadence, runbook).
