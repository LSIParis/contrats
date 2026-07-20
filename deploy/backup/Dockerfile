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
