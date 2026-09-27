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
#      (et OCR_TAG s'il est posé) dans ses variables, VÉRIFIE que toutes les
#      images de la stack sont disponibles, puis renvoie le même fichier compose.
#      Nécessite docker (compose, manifest) et jq sur la machine qui l'exécute.
#
# Le jeton ne passe jamais en argument de commande (fichier d'en-tête 600) et
# rien de ce qui est relu (variables de la stack, secrets compris) n'est affiché.
# -----------------------------------------------------------------------------
set -euo pipefail

tag="${1:?usage: redeploy-stack.sh <tag>}"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "::error::Tag d'image invalide : ${tag}"; exit 1; }
base="${PORTAINER_API_BASE:-https://127.0.0.1:${TUNNEL_PORT:?}/api}"
# --insecure : certificat auto-signé de Portainer, trafic confiné au tunnel SSH local.
CURL=(curl --silent --show-error --insecure)

# Appel nommé : en cas d'échec, dit QUEL appel a échoué et quoi vérifier.
#   call "<libellé>" <options curl…>   (le corps de réponse va où -o l'indique)
call() {
  local what="$1"; shift
  local code
  code="$("${CURL[@]}" -w '%{http_code}' "$@")" || { echo "::error::${what} : Portainer injoignable (curl $?)."; return 1; }
  [ "$code" -lt 400 ] && return 0
  case "$code" in
    401) echo "::error::${what} : jeton refusé (401) — jeton expiré, révoqué ou mal copié dans PORTAINER_API_TOKEN." ;;
    403) echo "::error::${what} : accès refusé (403) — le compte du jeton n'a pas de droits sur la stack ${PORTAINER_STACK_ID:-?} ou sur son environnement (09-exploitation.md §4.8, étapes 2 et 3)." ;;
    404) echo "::error::${what} : introuvable (404) — vérifier PORTAINER_STACK_ID (${PORTAINER_STACK_ID:-?}) ou l'identifiant du webhook." ;;
    *)   echo "::error::${what} : échec (HTTP ${code})." ;;
  esac
  return 1
}

if [ -n "${PORTAINER_WEBHOOK_ID:-}" ]; then
  call "Webhook de la stack" --max-time 30 -o /dev/null -X POST "${base}/stacks/webhooks/${PORTAINER_WEBHOOK_ID}?tag=${tag}"
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

call "Lecture de la stack ${PORTAINER_STACK_ID}" --max-time 30 -H @"$work/auth" -o "$work/stack.json" "${base}/stacks/${PORTAINER_STACK_ID}"
call "Lecture du fichier compose" --max-time 30 -H @"$work/auth" -o "$work/file.json" "${base}/stacks/${PORTAINER_STACK_ID}/file"

endpoint="$(jq -r '.EndpointId' "$work/stack.json")"
[[ "$endpoint" =~ ^[0-9]+$ ]] || { echo "::error::Stack ${PORTAINER_STACK_ID} : environnement introuvable."; exit 1; }
jq -e 'any(.Env[]?; .name == "CONTRATS_TAG")' "$work/stack.json" > /dev/null \
  || { echo "::error::La stack ${PORTAINER_STACK_ID} n'a pas de variable CONTRATS_TAG."; exit 1; }
previous="$(jq -r '.Env[] | select(.name == "CONTRATS_TAG") | .value' "$work/stack.json")"

# Tag de version (X.Y.Z) : image immuable → tirée seulement si absente de l'hôte
# (une image présente seulement en local, comme le miroir MinIO, reste utilisable).
# Tag mobile (main, sha-…) : tirage systématique pour prendre la dernière image.
if [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then pull=false; else pull=true; fi

# OCR_TAG, s'il est posé, suit la version de l'application (l'image OCR est
# publiée à chaque tag de version) : un OCR_TAG figé sur une ancienne version
# introuvable a déjà fait échouer un déploiement.
jq -n \
  --rawfile file <(jq -r '.StackFileContent' "$work/file.json") \
  --slurpfile stack "$work/stack.json" \
  --arg tag "$tag" \
  --argjson pull "$pull" \
  '{
     stackFileContent: $file,
     env: [ $stack[0].Env[] | if .name == "CONTRATS_TAG" or (.name == "OCR_TAG" and .value != "") then .value = $tag else . end ],
     prune: false,
     pullImage: $pull
   }' > "$work/payload.json"

# --- Contrôle préalable : TOUTES les images de la stack doivent être disponibles.
# Portainer arrête la stack AVANT de tirer les images : une image introuvable
# coupe donc la production. On vérifie chaque image (présente sur l'hôte, ou
# publiée) avant de toucher à quoi que ce soit.
jq -r '.env[] | "\(.name)=\(.value)"' "$work/payload.json" > "$work/stack.env"
jq -r '.stackFileContent' "$work/payload.json" > "$work/compose.yml"
docker compose -p redeploy-check --env-file "$work/stack.env" -f "$work/compose.yml" config --images 2>"$work/compose.err" \
  | sort -u > "$work/images.txt" \
  || { echo "::error::Fichier compose de la stack invalide avec ces variables : $(tail -1 "$work/compose.err")"; exit 1; }
call "Liste des images de l'hôte" --max-time 60 -H @"$work/auth" -o "$work/host-images.json" \
  "${base}/endpoints/${endpoint}/docker/images/json"
jq -r '.[].RepoTags[]?' "$work/host-images.json" | sort -u > "$work/host-images.txt"
mkdir -p "$work/anon" && missing=0
while read -r image; do
  [ -n "$image" ] || continue
  on_host=false
  grep -qxF "$image" "$work/host-images.txt" && on_host=true
  if [ "$pull" = false ] && [ "$on_host" = true ]; then
    echo "  présente sur l'hôte : ${image}"
  elif DOCKER_CONFIG="$work/anon" docker manifest inspect "$image" > /dev/null 2>&1; then
    echo "  publiée             : ${image}"
  elif [ "$on_host" = true ]; then
    # Tirage systématique demandé (tag mobile) : Portainer échouerait sur cette image.
    echo "::error::Image présente sur l'hôte mais absente du registre, alors qu'un tirage systématique est demandé (tag mobile ${tag}) : ${image}"; missing=1
  else
    echo "::error::Image introuvable, ni sur l'hôte ni dans le registre : ${image}"; missing=1
  fi
done < "$work/images.txt"
[ "$missing" -eq 0 ] || { echo "::error::Redéploiement annulé AVANT tout arrêt de la stack : la production n'est pas touchée."; exit 1; }

# Recréation des conteneurs (et tirage des images manquantes) : plusieurs minutes possibles.
call "Mise à jour de la stack (tag ${tag})" --max-time 900 -X PUT -H @"$work/auth" -H 'Content-Type: application/json' \
  --data-binary @"$work/payload.json" -o /dev/null \
  "${base}/stacks/${PORTAINER_STACK_ID}?endpointId=${endpoint}"
echo "Stack ${PORTAINER_STACK_ID} redéployée par l'API : CONTRATS_TAG ${previous} → ${tag} (tirage systématique : ${pull})."
