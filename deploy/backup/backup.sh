#!/bin/sh
# Un cycle : pg_dump -> Wasabi, mirror MinIO -> Wasabi, puis heartbeat.
# set -e : toute erreur sort non-zero AVANT le heartbeat -> Uptime Kuma alerte.
set -eu

STAMP="$(date +%Y-%m-%dT%H%M)"
TMP="/tmp/lsi_${STAMP}.dump"
# Nettoie le dump temporaire quoi qu'il arrive (y compris si l'upload echoue) :
# sinon les dumps s'accumulent dans /tmp au fil des reessais nocturnes.
trap 'rm -f "$TMP"' EXIT

echo "[backup] pg_dump ${STAMP}..."
pg_dump -Fc -f "$TMP"            # PGHOST/PGUSER/PGPASSWORD/PGDATABASE via env

echo "[backup] upload pg -> wasabi/${WASABI_BUCKET}/pg/${STAMP}.dump"
mc cp "$TMP" "wasabi/${WASABI_BUCKET}/pg/${STAMP}.dump"
rm -f "$TMP"

echo "[backup] mirror minio (local/${S3_BUCKET}) -> wasabi/${WASABI_BUCKET}/minio/"
mc mirror --overwrite "local/${S3_BUCKET}" "wasabi/${WASABI_BUCKET}/minio/"

echo "[backup] succes -> heartbeat Uptime Kuma"
# Le heartbeat ne doit pas faire echouer la sauvegarde : garde || echo.
# On enleve toute query deja presente sur l'URL (l'utilisateur peut coller
# l'URL Uptime complete "...?status=up&msg=OK&ping=") avant d'ajouter la notre,
# sinon on obtiendrait un double "?" invalide.
if [ -n "${UPTIME_PUSH_URL:-}" ]; then
  base="${UPTIME_PUSH_URL%%[?]*}"
  curl -fsS -m 15 "${base}?status=up&msg=OK" >/dev/null 2>&1 || echo "[backup] warn: heartbeat KO"
fi
echo "[backup] termine"
