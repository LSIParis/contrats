#!/usr/bin/env bash
# =============================================================================
# Clé SSH de déploiement dédiée à l'application « Contrats »
#
# Utilisée UNIQUEMENT par GitHub Actions (deploy.yml) pour ouvrir un tunnel
# SSH vers Portainer, qui écoute sur la boucle locale du VPS (127.0.0.1:9443)
# et n'est jamais exposé sur Internet.
#
# Ce script, exécuté sur le POSTE D'ADMINISTRATION (jamais sur le VPS, jamais
# dans le dépôt) :
#   1. génère ~/.ssh/lsi_contrats_deploy (ed25519, -a 100, sans phrase de passe)
#      et refuse d'écraser une clé existante ;
#   2. affiche la ligne authorized_keys restreinte à installer sur le VPS ;
#   3. relève l'empreinte ed25519 de l'hôte (ssh-keyscan) et rappelle de la
#      COMPARER à celle lue sur le VPS avant de lui faire confiance ;
#   4. affiche (ou exécute avec --apply) les commandes `gh` qui stockent la clé
#      et l'empreinte dans les secrets des environnements GitHub ;
#   5. affiche (ou exécute avec --test) les tests de cloisonnement.
#
# Procédure complète, rotation et révocation : docs/contrats/09-exploitation.md
#
# Usage :
#   deploy/ssh/create-deploy-key.sh [options]
#     --host HOST        VPS (défaut : 51.178.30.81)
#     --user USER        compte SSH sur le VPS (défaut : lsi)
#     --key PATH         clé à créer (défaut : ~/.ssh/lsi_contrats_deploy)
#                        pour une rotation : --key ~/.ssh/lsi_contrats_deploy_$(date +%Y%m)
#     --portainer ADDR   adresse locale de Portainer sur le VPS (défaut : 127.0.0.1:9443)
#     --repo OWNER/REPO  dépôt GitHub (défaut : LSIParis/contrats)
#     --env NAME         environnement GitHub (répétable ; défaut : staging et production)
#     --apply            exécute les `gh secret set` / `gh variable set` (demande
#                        confirmation de la vérification de l'empreinte)
#     --test             la clé étant installée sur le VPS, exécute les tests
#                        de cloisonnement (sans générer de clé)
#     -h, --help         cette aide
# =============================================================================
set -euo pipefail

HOST="51.178.30.81"
VPS_USER="lsi"
KEY="${HOME}/.ssh/lsi_contrats_deploy"
PORTAINER="127.0.0.1:9443"
REPO="LSIParis/contrats"
ENVS=()
APPLY=0
TEST_ONLY=0
COMMENT="gha-deploy-contrats@lsi-maintenance.fr"
TUNNEL_PORT=19443

usage() { sed -n '/^# Usage :/,/^# =====/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^=====/d'; }
die() { echo "✗ $*" >&2; exit 1; }
title() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host attend une valeur}"; shift 2 ;;
    --user) VPS_USER="${2:?--user attend une valeur}"; shift 2 ;;
    --key) KEY="${2:?--key attend une valeur}"; shift 2 ;;
    --portainer) PORTAINER="${2:?--portainer attend une valeur}"; shift 2 ;;
    --repo) REPO="${2:?--repo attend une valeur}"; shift 2 ;;
    --env) ENVS+=("${2:?--env attend une valeur}"); shift 2 ;;
    --apply) APPLY=1; shift ;;
    --test) TEST_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "option inconnue : $1 (voir --help)" ;;
  esac
done
[ ${#ENVS[@]} -gt 0 ] || ENVS=(staging production)

KNOWN_HOSTS="${KEY}.known_hosts"
# Options SSH communes : n'utiliser QUE cette clé, n'accepter QUE l'empreinte
# enregistrée (comme deploy.yml : StrictHostKeyChecking=yes).
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
          -o UserKnownHostsFile="$KNOWN_HOSTS" -o BatchMode=yes -o ConnectTimeout=10)

# -----------------------------------------------------------------------------
# Tests de cloisonnement (après installation de la clé sur le VPS)
# -----------------------------------------------------------------------------
run_tests() {
  [ -f "$KEY" ] || die "clé absente : $KEY"
  [ -f "$KNOWN_HOSTS" ] || die "empreinte absente : $KNOWN_HOSTS"
  local failed=0

  local out
  title "Test 1 — aucun shell (y compris sans PTY)"
  # `restrict` refuse le PTY, mais sans commande forcée un shell SANS PTY
  # s'ouvre quand même et lit l'entrée standard : on le vérifie ainsi.
  out="$(printf 'echo PWNED\nexit\n' | ssh "${SSH_OPTS[@]}" -T "${VPS_USER}@${HOST}" 2>/dev/null || true)"
  if printf '%s' "$out" | grep -q PWNED; then
    echo "✗ ÉCHEC : un shell s'ouvre avec la clé de déploiement (command=\"/bin/false\" manquant ?)."; failed=1
  else
    echo "✓ shell refusé"
  fi

  title "Test 2 — aucune commande distante"
  out="$(ssh "${SSH_OPTS[@]}" "${VPS_USER}@${HOST}" 'echo PWNED' </dev/null 2>/dev/null || true)"
  if [ "$out" = "PWNED" ]; then
    echo "✗ ÉCHEC : la clé exécute des commandes (ajouter command=\"/bin/false\" à la ligne authorized_keys)."; failed=1
  else
    echo "✓ commande refusée"
  fi

  title "Test 3 — le tunnel vers Portainer (${PORTAINER}) fonctionne"
  local sock
  sock="$(mktemp -u "${TMPDIR:-/tmp}/contrats-tunnel.XXXXXX")"
  if ssh "${SSH_OPTS[@]}" -o ExitOnForwardFailure=yes -M -S "$sock" -fNT \
       -L "127.0.0.1:${TUNNEL_PORT}:${PORTAINER}" "${VPS_USER}@${HOST}"; then
    if curl --silent --insecure --max-time 5 -o /dev/null -w '%{http_code}' \
         "https://127.0.0.1:${TUNNEL_PORT}/api/system/status" | grep -q '^200$'; then
      echo "✓ Portainer répond à travers le tunnel"
    else
      echo "✗ ÉCHEC : tunnel ouvert mais Portainer ne répond pas sur ${PORTAINER}"; failed=1
    fi
    ssh -S "$sock" -O exit "${VPS_USER}@${HOST}" >/dev/null 2>&1 || true
  else
    echo "✗ ÉCHEC : ouverture du tunnel refusée (AllowTcpForwarding ? permitopen ?)"; failed=1
  fi

  title "Test 4 — aucun autre transfert que ${PORTAINER}"
  # Le client ouvre l'écoute locale ; c'est le SERVEUR qui doit refuser le
  # canal vers 127.0.0.1:22. Refus = pas de bannière « SSH-… » à la lecture.
  local probe_port=$((TUNNEL_PORT + 1)) banner="" pid
  ssh "${SSH_OPTS[@]}" -N -L "127.0.0.1:${probe_port}:127.0.0.1:22" "${VPS_USER}@${HOST}" \
    </dev/null >/dev/null 2>&1 &
  pid=$!
  sleep 3
  if exec 3<>"/dev/tcp/127.0.0.1/${probe_port}" 2>/dev/null; then
    IFS= read -r -t 3 banner <&3 || true
    exec 3<&- 3>&-
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  case "$banner" in
    SSH-*) echo "✗ ÉCHEC : transfert vers 127.0.0.1:22 accepté (permitopen absent ?)"; failed=1 ;;
    *) echo "✓ transfert vers une autre destination refusé" ;;
  esac

  echo
  if [ "$failed" -eq 0 ]; then
    echo "✓ Cloisonnement conforme."
  else
    die "cloisonnement NON conforme : corriger avant de confier la clé à GitHub."
  fi
}

if [ "$TEST_ONLY" -eq 1 ]; then
  run_tests
  exit 0
fi

# -----------------------------------------------------------------------------
# 1. Génération
# -----------------------------------------------------------------------------
command -v ssh-keygen >/dev/null || die "ssh-keygen introuvable"
command -v ssh-keyscan >/dev/null || die "ssh-keyscan introuvable"

if [ -e "$KEY" ] || [ -e "${KEY}.pub" ]; then
  die "$KEY existe déjà : refus de l'écraser. Pour une rotation, choisir un autre --key."
fi
install -m 700 -d "$(dirname "$KEY")"

title "1. Génération de la clé ${KEY}"
# Pas de phrase de passe : la clé est utilisée par la CI. Sa sécurité repose
# sur les restrictions authorized_keys et sur le secret GitHub.
ssh-keygen -t ed25519 -a 100 -N "" -C "$COMMENT" -f "$KEY" >/dev/null
chmod 600 "$KEY"
echo "✓ clé privée : $KEY (600)"
echo "✓ clé publique : ${KEY}.pub"
ssh-keygen -lf "${KEY}.pub"

# -----------------------------------------------------------------------------
# 2. Ligne authorized_keys
# -----------------------------------------------------------------------------
PUB="$(cat "${KEY}.pub")"
# restrict        : ni PTY, ni agent, ni X11, ni ~/.ssh/rc, ni transfert…
# port-forwarding : …sauf le transfert local, et seulement vers
# permitopen      : l'adresse locale de Portainer.
# command="/bin/false" : `restrict` N'EMPÊCHE PAS l'exécution d'une commande
#   (`ssh lsi@vps 'id'` s'exécuterait, sans PTY). La commande forcée ferme
#   cette porte ; le tunnel de deploy.yml (-N, sans session) n'est pas affecté.
AUTH_LINE="restrict,port-forwarding,permitopen=\"${PORTAINER}\",command=\"/bin/false\" ${PUB}"

title "2. À ajouter sur le VPS dans /home/${VPS_USER}/.ssh/authorized_keys"
cat <<EOF
Depuis une session d'administration (VOTRE clé personnelle, pas celle-ci) :

  ssh ${VPS_USER}@${HOST}
  umask 077; mkdir -p ~/.ssh
  cat >> ~/.ssh/authorized_keys <<'KEY'
${AUTH_LINE}
KEY
  chmod 600 ~/.ssh/authorized_keys

Ligne seule :
${AUTH_LINE}

(Pas d'option from= : les runners hébergés par GitHub n'ont pas d'IP fixe.)
EOF

# -----------------------------------------------------------------------------
# 3. Empreinte de l'hôte
# -----------------------------------------------------------------------------
title "3. Empreinte ed25519 de ${HOST}"
ssh-keyscan -t ed25519 "$HOST" 2>/dev/null > "$KNOWN_HOSTS" || true
[ -s "$KNOWN_HOSTS" ] || die "ssh-keyscan n'a rien renvoyé pour ${HOST}"
chmod 644 "$KNOWN_HOSTS"
echo "Ligne known_hosts enregistrée dans ${KNOWN_HOSTS} :"
cat "$KNOWN_HOSTS"
echo
echo "Empreinte relevée À DISTANCE :"
ssh-keygen -lf "$KNOWN_HOSTS"
cat <<EOF

⚠ À COMPARER, caractère par caractère, avec l'empreinte lue SUR LE VPS
  (console OVH / session d'administration déjà de confiance) :

    ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub

  Si elles diffèrent : NE PAS continuer (interception possible). Supprimer
  ${KNOWN_HOSTS} et enquêter.
EOF

# -----------------------------------------------------------------------------
# 4. Secrets GitHub
# -----------------------------------------------------------------------------
title "4. Secrets et variables des environnements GitHub (${REPO})"
GH_CMDS=()
for env in "${ENVS[@]}"; do
  GH_CMDS+=("gh secret set VPS_SSH_KEY --repo ${REPO} --env ${env} < ${KEY}")
  GH_CMDS+=("gh secret set VPS_SSH_KNOWN_HOSTS --repo ${REPO} --env ${env} < ${KNOWN_HOSTS}")
  GH_CMDS+=("gh variable set VPS_HOST --repo ${REPO} --env ${env} --body ${HOST}")
  GH_CMDS+=("gh variable set VPS_USER --repo ${REPO} --env ${env} --body ${VPS_USER}")
done
printf '  %s\n' "${GH_CMDS[@]}"

if [ "$APPLY" -eq 1 ]; then
  command -v gh >/dev/null || die "gh (GitHub CLI) introuvable"
  gh auth status >/dev/null 2>&1 || die "gh n'est pas authentifié (gh auth login)"
  echo
  read -r -p "Empreinte vérifiée sur le VPS et identique ? Taper « oui » pour enregistrer les secrets : " answer </dev/tty
  [ "$answer" = "oui" ] || die "abandon : rien n'a été envoyé à GitHub."
  for env in "${ENVS[@]}"; do
    gh secret set VPS_SSH_KEY --repo "$REPO" --env "$env" < "$KEY"
    gh secret set VPS_SSH_KNOWN_HOSTS --repo "$REPO" --env "$env" < "$KNOWN_HOSTS"
    gh variable set VPS_HOST --repo "$REPO" --env "$env" --body "$HOST"
    gh variable set VPS_USER --repo "$REPO" --env "$env" --body "$VPS_USER"
    echo "✓ environnement ${env} configuré"
  done
else
  echo
  echo "(non exécutées : relancer avec --apply, ou les copier après vérification de l'empreinte)"
fi

# -----------------------------------------------------------------------------
# 5. Tests de cloisonnement
# -----------------------------------------------------------------------------
title "5. Tests de cloisonnement (après installation sur le VPS)"
cat <<EOF
  $0 --test --host ${HOST} --user ${VPS_USER} --key ${KEY}

ou à la main :
  # doit être REFUSÉ (pas de shell, pas de commande) :
  ssh -i ${KEY} -o IdentitiesOnly=yes ${VPS_USER}@${HOST}
  ssh -i ${KEY} -o IdentitiesOnly=yes ${VPS_USER}@${HOST} id
  # doit FONCTIONNER (puis https://127.0.0.1:${TUNNEL_PORT} répond) :
  ssh -i ${KEY} -o IdentitiesOnly=yes -N -L ${TUNNEL_PORT}:${PORTAINER} ${VPS_USER}@${HOST}
  # doit être REFUSÉ (destination hors permitopen) :
  ssh -i ${KEY} -o IdentitiesOnly=yes -N -L 19444:127.0.0.1:22 ${VPS_USER}@${HOST}

Ensuite : supprimer la clé privée du poste, ou la ranger dans le gestionnaire
de secrets. Elle ne doit exister qu'en secret GitHub :
  shred -u ${KEY}   # (ou rm -P sur macOS)
EOF
