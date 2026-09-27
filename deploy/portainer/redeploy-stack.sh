#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# redeploy-stack.sh — Redéploie la stack Portainer « Contrats » sur un tag d'image.
#
# Appelé par .github/workflows/deploy.yml (déploiement et retour arrière), à
# travers le tunnel SSH déjà ouvert vers Portainer (https://127.0.0.1:$TUNNEL_PORT).
#
#   redeploy-stack.sh <tag>
#
# Deux voies, choisies selon les secrets présents :
#   1. PORTAINER_WEBHOOK_ID  : webhook de stack (Business Edition), ?tag=<tag>.
#   2. PORTAINER_API_TOKEN + PORTAINER_STACK_ID : API de Portainer (Community
#      Edition, sans webhook de stack) — relit la stack, remplace CONTRATS_TAG
#      dans ses variables, renvoie le même fichier compose avec pullImage=true.
#
# Le jeton ne passe jamais en argument de commande (fichier d'en-tête 600) et
# rien de ce qui est relu (variables de la stack, secrets compris) n'est affiché.
# -----------------------------------------------------------------------------
set -euo pipefail

tag="${1:?usage: redeploy-stack.sh <tag>}"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "::error::Tag d'image invalide : ${tag}"; exit 1; }
base="${PORTAINER_API_BASE:-https://127.0.0.1:${TUNNEL_PORT:?}/api}"
# --insecure : certificat auto-signé de Portainer, trafic confiné au tunnel SSH local.
CURL=(curl --fail --silent --show-error --insecure)

if [ -n "${PORTAINER_WEBHOOK_ID:-}" ]; then
  "${CURL[@]}" --max-time 30 -X POST "${base}/stacks/webhooks/${PORTAINER_WEBHOOK_ID}?tag=${tag}"
  echo "Stack redéployée par webhook sur le tag ${tag}."
  exit 0
fi

: "${PORTAINER_API_TOKEN:?PORTAINER_API_TOKEN ou PORTAINER_WEBHOOK_ID requis}"
: "${PORTAINER_STACK_ID:?PORTAINER_STACK_ID requis avec PORTAINER_API_TOKEN}"
[[ "$PORTAINER_STACK_ID" =~ ^[0-9]+$ ]] || { echo "::error::PORTAINER_STACK_ID doit être numérique."; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
printf 'X-API-Key: %s\n' "$PORTAINER_API_TOKEN" > "$work/auth"

"${CURL[@]}" --max-time 30 -H @"$work/auth" "${base}/stacks/${PORTAINER_STACK_ID}" -o "$work/stack.json"
"${CURL[@]}" --max-time 30 -H @"$work/auth" "${base}/stacks/${PORTAINER_STACK_ID}/file" -o "$work/file.json"

endpoint="$(jq -r '.EndpointId' "$work/stack.json")"
[[ "$endpoint" =~ ^[0-9]+$ ]] || { echo "::error::Stack ${PORTAINER_STACK_ID} : environnement introuvable."; exit 1; }
jq -e 'any(.Env[]?; .name == "CONTRATS_TAG")' "$work/stack.json" > /dev/null \
  || { echo "::error::La stack ${PORTAINER_STACK_ID} n'a pas de variable CONTRATS_TAG."; exit 1; }
previous="$(jq -r '.Env[] | select(.name == "CONTRATS_TAG") | .value' "$work/stack.json")"

jq -n \
  --rawfile file <(jq -r '.StackFileContent' "$work/file.json") \
  --slurpfile stack "$work/stack.json" \
  --arg tag "$tag" \
  '{
     stackFileContent: $file,
     env: [ $stack[0].Env[] | if .name == "CONTRATS_TAG" then .value = $tag else . end ],
     prune: false,
     pullImage: true
   }' > "$work/payload.json"

# Tirage de l'image + recréation des conteneurs : peut prendre plusieurs minutes.
"${CURL[@]}" --max-time 900 -X PUT -H @"$work/auth" -H 'Content-Type: application/json' \
  --data-binary @"$work/payload.json" -o /dev/null \
  "${base}/stacks/${PORTAINER_STACK_ID}?endpointId=${endpoint}"
echo "Stack ${PORTAINER_STACK_ID} redéployée par l'API : CONTRATS_TAG ${previous} → ${tag}."
