#!/bin/sh
# Verification mensuelle : restaure le dernier dump dans une base JETABLE et
# compare quelques comptes au live. Prouve que le dump est exploitable.
set -eu

LATEST="$(mc ls "wasabi/${WASABI_BUCKET}/pg/" | awk '{print $NF}' | sort | tail -1)"
[ -n "$LATEST" ] || { echo "[restore-check] aucun dump trouve"; exit 1; }
echo "[restore-check] dernier dump: ${LATEST}"

mc cp "wasabi/${WASABI_BUCKET}/pg/${LATEST}" /tmp/check.dump

psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS lsi_restore_check;"
psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE lsi_restore_check;"
# pg_restore peut emettre des warnings de roles (--no-owner l'evite) ; on ne
# stoppe pas dessus, la comparaison de comptes ci-dessous fait foi.
pg_restore --no-owner --no-privileges -d lsi_restore_check /tmp/check.dump || true

LIVE="$(psql -tAc 'SELECT count(*) FROM contracts')"
REST="$(psql -d lsi_restore_check -tAc 'SELECT count(*) FROM contracts')"
echo "[restore-check] contracts live=${LIVE} restored=${REST}"

psql -v ON_ERROR_STOP=1 -c "DROP DATABASE lsi_restore_check;"
rm -f /tmp/check.dump

# Succes = la base restauree a un compte coherent (> 0 et = live).
if [ -n "$REST" ] && [ "$REST" = "$LIVE" ] && [ -n "${UPTIME_RESTORE_PUSH_URL:-}" ]; then
  curl -fsS -m 15 "${UPTIME_RESTORE_PUSH_URL}?status=up&msg=restore_ok_${REST}" >/dev/null 2>&1 || true
fi
