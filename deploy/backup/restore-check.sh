#!/bin/sh
# Verification mensuelle : restaure le dernier dump dans une base JETABLE et
# compare quelques comptes au live. Prouve que le dump est exploitable.
set -eu

# La base jetable est TOUJOURS supprimee en sortie, quel que soit le resultat :
# un pg_restore rate ne doit pas laisser d'orphelin sur le serveur live.
cleanup() {
  psql -c "DROP DATABASE IF EXISTS lsi_restore_check;" >/dev/null 2>&1 || true
  rm -f /tmp/check.dump
}
trap cleanup EXIT

LATEST="$(mc ls "wasabi/${WASABI_BUCKET}/pg/" | awk '{print $NF}' | sort | tail -1)"
[ -n "$LATEST" ] || { echo "[restore-check] aucun dump trouve"; exit 1; }
echo "[restore-check] dernier dump: ${LATEST}"

mc cp "wasabi/${WASABI_BUCKET}/pg/${LATEST}" /tmp/check.dump

psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS lsi_restore_check;"
psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE lsi_restore_check;"
# pg_restore peut emettre des warnings de roles (--no-owner l'evite) ; on ne
# stoppe pas dessus, la comparaison de comptes ci-dessous fait foi.
pg_restore --no-owner --no-privileges -d lsi_restore_check /tmp/check.dump || true

# Les requetes de comptage ne doivent PAS tuer le script (busybox ash + set -e
# avorte sur une substitution en echec, ce qui sauterait le cleanup) : on
# capture, on laisse vide en cas d'echec, et le trap EXIT nettoie de toute facon.
LIVE="$(psql -tAc 'SELECT count(*) FROM contracts' 2>/dev/null)" || LIVE=""
REST="$(psql -d lsi_restore_check -tAc 'SELECT count(*) FROM contracts' 2>/dev/null)" || REST=""
echo "[restore-check] contracts live=${LIVE} restored=${REST}"

# Succes = base restauree avec un compte coherent (non vide ET egal au live).
if [ -n "$REST" ] && [ "$REST" = "$LIVE" ]; then
  echo "[restore-check] OK"
  if [ -n "${UPTIME_RESTORE_PUSH_URL:-}" ]; then
    # Enleve toute query deja presente avant d'ajouter la notre (cf. backup.sh).
    base="${UPTIME_RESTORE_PUSH_URL%%[?]*}"
    curl -fsS -m 15 "${base}?status=up&msg=restore_ok_${REST}" >/dev/null 2>&1 || true
  fi
else
  echo "[restore-check] ECHEC : comptes incoherents (live=${LIVE} restored=${REST})"
  exit 1
fi
