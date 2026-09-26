# Déploiement — application « Contrats »

La procédure complète (GitHub, GHCR, clé SSH, Portainer, reverse proxy, DNS,
mise à jour, retour arrière, sauvegardes, supervision) est dans
**[`docs/contrats/09-exploitation.md`](../docs/contrats/09-exploitation.md)**.
Ce dossier ne contient que les fichiers qu'elle utilise.

| Chemin | Rôle |
|---|---|
| `portainer/docker-compose.yml` | Stack Portainer (production `contrats`, préproduction `contrats-preprod`) : uniquement des `image:`, tag `${CONTRATS_TAG}` obligatoire |
| `portainer/stack.env.example` | Toutes les variables de la stack, documentées, sans valeur réelle |
| `migrate.sh` | Job one-shot `migrate` : `prisma migrate deploy` puis rotation des mots de passe des rôles `lsi_app`, `lsi_webhook`, `lsi_scheduler` |
| `ocr/` | Image `contrats-ocr` : ocrmypdf + Tesseract `fra` derrière un mini-serveur HTTP interne (voir `ocr/README.md`) |
| `backup/` | Image `contrats-backup` : `pg_dump` + miroir MinIO vers Wasabi, contrôle de restauration mensuel (`backup/RESTORE.md`) ; sert aussi au job `minio-init` |
| `ssh/create-deploy-key.sh` | Création de la clé SSH de déploiement dédiée (GitHub Actions → tunnel vers Portainer) |
| `wireguard/README.md` | Tunnel chiffré entre le reverse proxy (51.91.98.38) et le VPS applicatif (51.178.30.81) |

L'ancien `docker-compose.stack.yml` (stack `lsi-contrats`, PostgreSQL 16,
tag `latest`) est remplacé par `portainer/docker-compose.yml`. La bascule d'une
base 16 existante vers 17 est décrite dans `09-exploitation.md`.

Images publiées sur GHCR (privées) :

| Image | Publiée par | Tags |
|---|---|---|
| `ghcr.io/<owner>/contrats` | `.github/workflows/release.yml` (annexe A) | `sha-xxxxxxx`, `main`, `X.Y.Z`, `X.Y` |
| `ghcr.io/<owner>/contrats-ocr` | `.github/workflows/images-annexes.yml` | idem |
| `ghcr.io/<owner>/contrats-backup` | `.github/workflows/images-annexes.yml` | idem |
