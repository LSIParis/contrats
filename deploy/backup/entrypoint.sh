#!/bin/sh
# Configure les alias mc depuis l'env, puis lance le planificateur.
# Fail-fast : si un secret manque, mc alias set echoue et le conteneur s'arrete
# (visible dans Portainer) plutot que de tourner sans jamais sauvegarder.
set -eu

: "${WASABI_ENDPOINT:?}" "${WASABI_ACCESS_KEY:?}" "${WASABI_SECRET_KEY:?}" "${WASABI_BUCKET:?}"
: "${S3_ACCESS_KEY:?}" "${S3_SECRET_KEY:?}" "${S3_BUCKET:?}"

mc alias set local  "http://minio:9000"   "$S3_ACCESS_KEY"     "$S3_SECRET_KEY"
mc alias set wasabi "$WASABI_ENDPOINT"     "$WASABI_ACCESS_KEY" "$WASABI_SECRET_KEY"

# Surveillance non bloquante : on n'exige PAS UPTIME_PUSH_URL (une sauvegarde
# vaut mieux qu'aucune), mais on avertit fort si elle est absente — sinon des
# sauvegardes tourneraient sans aucun signal, ce qui viderait Uptime Kuma de
# son role.
[ -n "${UPTIME_PUSH_URL:-}" ] || echo "[backup] AVERTISSEMENT : UPTIME_PUSH_URL non defini — sauvegardes NON surveillees"

echo "[backup] alias mc configures ; planificateur demarre (backup 02h00, restore-check le 1er 03h00)"
# -no-reap : en PID 1, le reaper de supercronic plante ("Failed to fork exec")
# sur cette image. On le desactive : les jobs (backup.sh/restore-check.sh)
# attendent deja leurs propres enfants, donc aucun orphelin a moissonner.
exec supercronic -no-reap /etc/crontab
