# Sauvegardes PostgreSQL + MinIO → Wasabi

**Date** : 2026-07-20
**Statut** : validé, prêt pour plan d'implémentation
**Portée** : mettre en place des sauvegardes quotidiennes, hors-site et chiffrées
de la base PostgreSQL et du stockage objet MinIO (PDF signés + pistes d'audit)
vers Wasabi, avec surveillance et procédure de restauration testée.

## 1. Objectif et constat

La stack `lsi-contrats` (hôte *Docker Legal*, OVH Paris, endpoint 5) n'a
**aucune sauvegarde**. Les volumes `pgdata` (contrats, versions, signatures,
utilisateurs) et `miniodata` (PDF signés + pistes d'audit, valeur **légale**)
ne survivraient pas à une perte de l'hôte, une corruption, ou une suppression
accidentelle/malveillante. `redisdata` est une file de jobs transitoire,
reconstruite par la réconciliation — **hors périmètre**.

## 2. Décisions (arrêtées au cadrage)

| Sujet | Décision |
|---|---|
| Destination | **Wasabi Paris** (`s3.eu-west-2.wasabisys.com`), bucket **`lsi-contrats`**, préfixes `pg/` et `minio/`. Région UE (RGPD). |
| Chiffrement | **SSE** (chiffrement serveur Wasabi) — pas de passphrase à gérer côté client. |
| Immuabilité | **Object lock déjà activé** sur le bucket → les copies ne peuvent être ni écrasées ni supprimées pendant la rétention (anti-suppression/ransomware). |
| PostgreSQL | `pg_dump -Fc` (format custom, compressé) → `s3://lsi-contrats/pg/AAAA-MM-JJ.dump`. |
| MinIO | `mc mirror` **additif** (jamais `--remove`) → `s3://lsi-contrats/minio/`. L'object lock garantit qu'une suppression côté MinIO ne détruit pas la copie. |
| Cadence | quotidienne à **02h00 Europe/Paris**. RPO ≤ 24 h. |
| Rétention | **90 jours** (= minimum de facturation Wasabi), via une règle de cycle de vie Wasabi (bornée par l'object lock). |
| Surveillance | **Uptime Kuma** (push monitor) : heartbeat à chaque succès → alerte si une nuit est manquée. |
| Mécanisme | conteneur dédié **`contrats-backup`** (image construite par la CI, tirée depuis ghcr comme l'app), service de la stack `lsi-contrats`. |

## 3. Architecture

### 3.1 Image `contrats-backup`
`FROM postgres:16-alpine` (fournit `pg_dump`/`psql` en version alignée sur la
base, `postgres:16-alpine`), + `mc` (client MinIO, binaire statique) + `curl`.
Construite par la CI et publiée sur `ghcr.io/lsiparis/contrats-backup`
(mêmes tags `sha-` + `latest` que l'app). Le script de sauvegarde vit dans le
dépôt (`deploy/backup/backup.sh`) et est **copié dans l'image** (versionné,
revu, testable) — pas d'installation à l'exécution.

Planification : `supercronic` (cron adapté aux conteneurs, logs sur stdout)
avec une entrée `0 2 * * *`. Le conteneur reste up ; supercronic déclenche
`backup.sh` à l'heure dite. `TZ=Europe/Paris`.

### 3.2 Service `backup` (dans `deploy/docker-compose.stack.yml`)
- Même réseau interne que la stack → joint `postgres:5432` et `minio:9000`
  directement (aucune exposition publique).
- Variables :
  - `PGHOST=postgres`, `PGDATABASE=lsi_contrats`, `PGUSER=postgres`,
    `PGPASSWORD=${POSTGRES_SUPERUSER_PASSWORD}` (réutilise l'env existant).
  - Source MinIO : `S3_ACCESS_KEY`/`S3_SECRET_KEY` (existants), endpoint
    `http://minio:9000`, bucket `lsi-contrats`.
  - Cible Wasabi : `WASABI_ENDPOINT=https://s3.eu-west-2.wasabisys.com`,
    `WASABI_BUCKET=lsi-contrats`, `WASABI_ACCESS_KEY`, `WASABI_SECRET_KEY`
    **(nouveaux secrets — créés et collés par Philippe dans l'env de la stack)**.
  - `UPTIME_PUSH_URL` (URL du push monitor Uptime Kuma, fournie par Philippe).
- `restart: unless-stopped`. Dépend de `postgres` et `minio` (condition
  `service_healthy`).

### 3.3 `backup.sh` (déroulé d'un cycle)
1. `pg_dump -Fc` de `lsi_contrats` → fichier temporaire ; **échec ⇒ on
   n'envoie rien et on sort en erreur** (pas de faux positif de succès).
2. `mc cp` du dump → `wasabi/lsi-contrats/pg/AAAA-MM-JJ.dump` (SSE activé côté
   bucket).
3. `mc mirror` (sans `--remove`, avec `--overwrite`) du bucket MinIO
   `local/lsi-contrats` → `wasabi/lsi-contrats/minio/`.
4. Nettoyage du fichier temporaire local.
5. **Seulement si toutes les étapes réussissent** : `curl` vers
   `UPTIME_PUSH_URL?status=up&msg=OK`. En cas d'échec à n'importe quelle
   étape : log explicite, code de sortie non nul, **pas de ping** (Uptime Kuma
   déclenche l'alerte sur heartbeat manquant).

Idempotence : le nom du dump est daté au jour ; l'object lock empêche
l'écrasement mais un second run le même jour viserait le même nom → on
suffixe l'heure (`AAAA-MM-JJTHHMM`) pour éviter tout conflit d'écriture sur
objet verrouillé.

### 3.4 Cycle de vie Wasabi (rétention 90 j)
Une règle de lifecycle (`mc ilm rule add`, idempotente au démarrage du
conteneur) expire les objets sous `pg/` après 90 jours. Les objets `minio/`
suivent le même principe côté versions non-courantes. La suppression effective
reste subordonnée à l'expiration de l'object lock — comportement voulu.

## 4. Restauration (le livrable qui compte vraiment)

- **Runbook** versionné (`deploy/backup/RESTORE.md`) : restaurer un dump
  (`mc cp` depuis Wasabi → `pg_restore` dans une base cible) et re-synchroniser
  MinIO (`mc mirror` Wasabi → MinIO). Étapes exactes, commandes copiables.
- **Vérification mensuelle automatique** : une entrée cron (`0 3 1 * *`)
  restaure le dernier dump dans une **base jetable** (`lsi_restore_check`),
  compare quelques comptes de lignes clés (contrats, signatures, versions) au
  live, puis `DROP DATABASE`. Résultat → ping Uptime Kuma dédié (monitor
  distinct « backup-restore-check »). Une sauvegarde jamais restaurée n'est
  pas une sauvegarde.

## 5. Sécurité

- Copies **chiffrées** (SSE Wasabi) et **immuables** (object lock), en **UE**
  (RGPD).
- Clé Wasabi dédiée, idéalement **limitée au bucket** `lsi-contrats` (policy
  Wasabi) — moindre privilège.
- Aucun secret dans le dépôt (dépôt **public**) : `WASABI_*` et
  `UPTIME_PUSH_URL` uniquement dans l'env de la stack Portainer. `backup.sh`
  ne lit que des variables d'environnement.
- Le conteneur n'expose aucun port ; il ne fait que sortir vers Wasabi + le
  push Uptime.

## 6. Déploiement et validation

- CI : ajouter un job `build-push` pour `ghcr.io/lsiparis/contrats-backup`
  (réutilise le cache, mêmes tags). L'app et la sauvegarde partagent le dépôt.
- Stack : ajouter le service `backup` au compose ; **une migration ? non**.
  Philippe crée la clé Wasabi + le push monitor Uptime Kuma et colle
  `WASABI_ACCESS_KEY`/`WASABI_SECRET_KEY`/`UPTIME_PUSH_URL` dans l'env avant le
  redéploiement (l'env live est préservé par le redeploy).
- **Validation réelle** : déclencher un premier cycle à la main (`supercronic`
  ou `backup.sh` direct dans le conteneur), vérifier que `pg/…​.dump` et
  `minio/…` apparaissent dans Wasabi, puis dérouler le runbook de restauration
  sur une base jetable pour prouver que le dump est exploitable.

## 7. Non-objectifs (différés)

- PITR / archivage WAL en continu (RPO < 24 h) — le dump logique quotidien
  suffit au MVP ; le WAL streaming viendra si le RPO doit descendre.
- Sauvegarde de Redis (transitoire).
- Réplication multi-région Wasabi.
- Rotation des clés Wasabi (relève de la dette « rotation des secrets »
  différée).
