#!/bin/sh
# Configure les alias mc depuis l'env, puis lance le planificateur.
# Fail-fast : si un secret manque, mc alias set echoue et le conteneur s'arrete
# (visible dans Portainer) plutot que de tourner sans jamais sauvegarder.
set -eu

: "${WASABI_ENDPOINT:?}" "${WASABI_ACCESS_KEY:?}" "${WASABI_SECRET_KEY:?}" "${WASABI_BUCKET:?}"
: "${S3_ACCESS_KEY:?}" "${S3_SECRET_KEY:?}" "${S3_BUCKET:?}"

mc alias set local  "http://minio:9000"   "$S3_ACCESS_KEY"     "$S3_SECRET_KEY"
mc alias set wasabi "$WASABI_ENDPOINT"     "$WASABI_ACCESS_KEY" "$WASABI_SECRET_KEY"

echo "[backup] alias mc configures ; planificateur demarre (backup 02h00, restore-check le 1er 03h00)"
exec supercronic /etc/crontab
