# Sauvegardes PostgreSQL + MinIO vers Wasabi (conteneur `backup` de la stack).
#
# PostgreSQL 17 : pg_dump doit être de même version majeure (ou plus récente)
# que le serveur. La stack Portainer tourne sur postgres:17-alpine.
FROM postgres:17-alpine

# mc (client S3) : MinIO ne distribue plus ses binaires communautaires
# (dl.min.io répond 410 Gone depuis fin 2025) ni d'images publiques. On
# reprend le binaire Go statique de l'image Chainguard, publique et épinglée
# par digest (mise à jour manuelle : le dependabot.yml de l'annexe A ne
# surveille que le Dockerfile racine).
COPY --from=cgr.dev/chainguard/minio-client:latest@sha256:b8b144ab34694ecea25aa352c4be9de4c26ee2a02701521dce02ee5593c57338 /usr/bin/mc /usr/local/bin/mc

# supercronic (cron pour conteneurs), curl, bash, tzdata. Binaire vérifié par
# somme SHA-1 publiée avec la release supercronic.
ARG SUPERCRONIC_VERSION=v0.2.33
ARG SUPERCRONIC_SHA1SUM=71b0d58cc53f6bd72cf2f293e09e294b79c666d8
RUN apk add --no-cache curl bash tzdata \
 && curl -fsSL "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" -o /usr/local/bin/supercronic \
 && echo "${SUPERCRONIC_SHA1SUM}  /usr/local/bin/supercronic" | sha1sum -c - \
 && chmod +x /usr/local/bin/supercronic \
 && mc --version >/dev/null

COPY entrypoint.sh backup.sh restore-check.sh /usr/local/bin/
COPY crontab /etc/crontab
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/backup.sh /usr/local/bin/restore-check.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
