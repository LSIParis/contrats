#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# create-deploy-key.sh — Clé SSH de déploiement dédiée à l'application « Contrats »
#
# À exécuter sur le poste d'administration (Linux, macOS, WSL ou Git Bash),
# JAMAIS sur le VPS ni dans la CI. La clé privée ne doit jamais être commitée.
#
# La clé créée est restreinte côté VPS au SEUL tunnel vers Portainer :
#   pas de shell, pas de commande, pas d'agent, pas de X11, pas de PTY,
#   transfert de port limité à PORTAINER_LOCAL (127.0.0.1:9443 par défaut).
#
# Sous-commandes :
#   create       Génère la paire de clés ed25519 (refuse d'écraser sans --force)
#   install      Installe la clé publique restreinte dans authorized_keys du VPS
#   known-hosts  Récupère et vérifie l'empreinte ed25519 du VPS
#   verify       Vérifie le cloisonnement (shell refusé, tunnel Portainer OK, autre port refusé)
#   github       Pousse secrets et variables dans les environnements GitHub (CLI gh)
#   revoke       Retire la clé du VPS (révocation d'urgence, ou --pub ancienne_cle.pub)
#   rotate       Nouvelle clé -> install -> verify -> github -> révocation de l'ancienne
#   all          create + install + known-hosts + verify (+ github si --repo est fourni)
#
# Exemples :
#   ./deploy/ssh/create-deploy-key.sh all
#   ./deploy/ssh/create-deploy-key.sh all --repo lsi-maintenance/contrats --env production,staging
#   ./deploy/ssh/create-deploy-key.sh rotate --repo lsi-maintenance/contrats --env production,staging
#   ./deploy/ssh/create-deploy-key.sh revoke
#   ./deploy/ssh/create-deploy-key.sh revoke --pub ~/.ssh/lsi_contrats_deploy.old.20261001120000.pub
#
# Options : --host --user --port --key --portainer --admin-identity --repo --env
#           --staging-url --pub --force -y|--yes
# -----------------------------------------------------------------------------
set -Eeuo pipefail
umask 077

# --- Paramètres (surchargables par variables d'environnement ou options) ------
VPS_HOST="${VPS_HOST:-51.178.30.81}"
VPS_USER="${VPS_USER:-lsi}"
VPS_PORT="${VPS_PORT:-22}"
PORTAINER_LOCAL="${PORTAINER_LOCAL:-127.0.0.1:9443}"
KEY_PATH="${KEY_PATH:-$HOME/.ssh/lsi_contrats_deploy}"
KEY_COMMENT="${KEY_COMMENT:-gha-deploy-contrats@lsi-maintenance.fr}"
KNOWN_HOSTS_OUT="${KNOWN_HOSTS_OUT:-$HOME/.ssh/known_hosts.contrats}"
APP_URL_PRODUCTION="${APP_URL_PRODUCTION:-https://contrats.lsi-maintenance.fr}"
APP_URL_STAGING="${APP_URL_STAGING:-}"
ADMIN_IDENTITY="${ADMIN_IDENTITY:-}"     # clé d'administration existante (sinon agent / ~/.ssh/config)
GH_REPO="${GH_REPO:-}"
GH_ENVS="${GH_ENVS:-production}"
TUNNEL_PORT="${TUNNEL_PORT:-19443}"
FORCE=0
ASSUME_YES=0
VERIFY_SOCK=""
REVOKE_PUB=""

# --- Affichage ---------------------------------------------------------------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B=; G=; Y=; R=; N=; fi
info() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s  ✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  !%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s  ✘%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local answer
  read -r -p "  $1 [o/N] " answer
  [[ "$answer" =~ ^[oOyY]$ ]]
}

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

require() { command -v "$1" >/dev/null 2>&1 || die "Commande requise introuvable : $1"; }

# --- Connexions SSH ----------------------------------------------------------
# Accès d'administration (clé personnelle existante) : sert à installer / révoquer.
admin_ssh() {
  local opts=(-p "$VPS_PORT" -o BatchMode=yes -o ConnectTimeout=10)
  [ -n "$ADMIN_IDENTITY" ] && opts+=(-i "$ADMIN_IDENTITY" -o IdentitiesOnly=yes)
  ssh "${opts[@]}" "${VPS_USER}@${VPS_HOST}" "$@"
}

# Accès avec la clé de déploiement, empreinte d'hôte stricte.
deploy_ssh() {
  ssh -p "$VPS_PORT" -i "$KEY_PATH" \
      -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
      -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS_OUT" \
      "$@"
}

authorized_line() {
  [ -f "${KEY_PATH}.pub" ] || die "Clé publique absente : ${KEY_PATH}.pub (lancer 'create')."
  local pub
  pub="$(cat "${KEY_PATH}.pub")"
  # restrict      : désactive PTY, agent, X11, transferts et ~/.ssh/rc
  # port-forwarding + permitopen : rouvre UNIQUEMENT le transfert local vers Portainer
  # command       : toute session shell ou commande est refusée (le tunnel -N n'ouvre pas de session)
  printf 'restrict,port-forwarding,permitopen="%s",command="/bin/false" %s\n' "$PORTAINER_LOCAL" "$pub"
}

key_blob() { awk '{print $2}' "$1"; }

# --- Sous-commandes ----------------------------------------------------------
cmd_create() {
  require ssh-keygen
  info "Génération de la clé de déploiement : $KEY_PATH"
  if [ -e "$KEY_PATH" ] || [ -e "${KEY_PATH}.pub" ]; then
    [ "$FORCE" -eq 1 ] || die "La clé existe déjà. Utiliser --force pour l'écraser, ou 'rotate'."
    warn "Écrasement demandé (--force)."
    rm -f "$KEY_PATH" "${KEY_PATH}.pub"
  fi
  mkdir -p "$(dirname "$KEY_PATH")"
  chmod 700 "$(dirname "$KEY_PATH")"
  # Pas de phrase de passe : clé destinée à la CI, protégée par ses restrictions et par le secret GitHub.
  ssh-keygen -q -t ed25519 -a 100 -N "" -C "$KEY_COMMENT" -f "$KEY_PATH"
  chmod 600 "$KEY_PATH"; chmod 644 "${KEY_PATH}.pub"
  ok "Clé créée : $(ssh-keygen -lf "${KEY_PATH}.pub")"
}

cmd_install() {
  require ssh
  local line
  line="$(authorized_line)"
  info "Installation de la clé restreinte sur ${VPS_USER}@${VPS_HOST} (via l'accès d'administration)"
  printf '  %s\n' "$line"
  confirm "Ajouter cette ligne à ~/.ssh/authorized_keys sur le VPS ?" || die "Abandon."

  # La ligne est transmise sur l'entrée standard : aucune interpolation côté distant.
  printf '%s\n' "$line" | admin_ssh '
    set -eu
    umask 077
    mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
    f="$HOME/.ssh/authorized_keys"; touch "$f"; chmod 600 "$f"
    IFS= read -r line
    blob=$(printf "%s\n" "$line" | awk "{print \$(NF-1)}")
    cp -p "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"
    if grep -qF "$blob" "$f"; then
      grep -vF "$blob" "$f" > "$f.tmp" || true
      printf "%s\n" "$line" >> "$f.tmp"
      mv "$f.tmp" "$f"; chmod 600 "$f"
      echo "Clé déjà présente : restrictions remises à jour."
    else
      printf "%s\n" "$line" >> "$f"
      echo "Clé ajoutée."
    fi
  '
  ok "authorized_keys mis à jour (sauvegarde horodatée conservée sur le VPS)."

  info "Contrôle de la configuration sshd (lecture seule, nécessite sudo sans mot de passe)"
  local sshd_conf
  if sshd_conf="$(admin_ssh "sudo -n sshd -T -C user=${VPS_USER},host=localhost,addr=127.0.0.1" 2>/dev/null)"; then
    grep -qi '^allowtcpforwarding \(yes\|local\|all\)' <<<"$sshd_conf" \
      && ok "AllowTcpForwarding autorisé pour ${VPS_USER}." \
      || warn "AllowTcpForwarding désactivé pour ${VPS_USER} : ajouter 'Match User ${VPS_USER}' + 'AllowTcpForwarding local' dans sshd_config."
    grep -qi '^passwordauthentication no' <<<"$sshd_conf" \
      && ok "Authentification par mot de passe désactivée." \
      || warn "PasswordAuthentication n'est pas à 'no' : à corriger."
  else
    warn "Impossible de lire la configuration sshd (sudo -n refusé). Vérifier manuellement : sudo sshd -T | grep -Ei 'allowtcpforwarding|passwordauthentication'"
  fi
}

cmd_known_hosts() {
  require ssh-keyscan
  info "Récupération de l'empreinte ed25519 de ${VPS_HOST}"
  local tmp scanned remote
  tmp="$(mktemp)"
  ssh-keyscan -p "$VPS_PORT" -t ed25519 "$VPS_HOST" 2>/dev/null > "$tmp"
  [ -s "$tmp" ] || { rm -f "$tmp"; die "ssh-keyscan n'a rien renvoyé pour ${VPS_HOST}:${VPS_PORT}."; }
  scanned="$(ssh-keygen -lf "$tmp" | awk '{print $2}')"
  printf '  Empreinte annoncée par le réseau : %s\n' "$scanned"

  # Comparaison avec la clé d'hôte lue sur le serveur via l'accès d'administration
  # (lui-même validé par le known_hosts habituel du poste).
  if remote="$(admin_ssh 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' 2>/dev/null | awk '{print $2}')" && [ -n "$remote" ]; then
    printf '  Empreinte lue sur le VPS          : %s\n' "$remote"
    [ "$scanned" = "$remote" ] || { rm -f "$tmp"; die "EMPREINTES DIFFÉRENTES : possible interception. Arrêt."; }
    ok "Empreintes identiques."
  else
    warn "Lecture distante impossible : comparer manuellement avec la console OVHcloud (KVM) :"
    warn "  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
    confirm "Confirmer que l'empreinte ${scanned} est bien celle du VPS ?" || { rm -f "$tmp"; die "Abandon."; }
  fi
  mv "$tmp" "$KNOWN_HOSTS_OUT"; chmod 644 "$KNOWN_HOSTS_OUT"
  ok "Empreinte enregistrée : $KNOWN_HOSTS_OUT (contenu du secret VPS_SSH_KNOWN_HOSTS)"
}

cmd_verify() {
  require ssh; require curl
  [ -f "$KEY_PATH" ] || die "Clé privée absente : $KEY_PATH"
  [ -s "$KNOWN_HOSTS_OUT" ] || die "Empreinte absente : $KNOWN_HOSTS_OUT (lancer 'known-hosts')."
  local status
  VERIFY_SOCK="$(mktemp -u "${TMPDIR:-/tmp}/contrats-ssh.XXXXXX")"
  info "Vérification du cloisonnement de la clé"

  # 1. Aucune commande ne doit s'exécuter
  if deploy_ssh "${VPS_USER}@${VPS_HOST}" 'echo SHELL_OUVERT' 2>/dev/null | grep -q SHELL_OUVERT; then
    die "La clé permet d'exécuter des commandes : restrictions absentes."
  fi
  ok "Exécution de commande refusée."

  # 2. Le tunnel vers Portainer doit fonctionner
  deploy_ssh -M -S "$VERIFY_SOCK" -fNT -o ExitOnForwardFailure=yes \
    -L "127.0.0.1:${TUNNEL_PORT}:${PORTAINER_LOCAL}" \
    -L "127.0.0.1:$((TUNNEL_PORT + 1)):127.0.0.1:${VPS_PORT}" \
    "${VPS_USER}@${VPS_HOST}" || die "Ouverture du tunnel impossible."
  trap 'ssh -S "$VERIFY_SOCK" -O exit "${VPS_USER}@${VPS_HOST}" >/dev/null 2>&1 || true' EXIT
  sleep 1
  status="$(curl --silent --insecure --max-time 5 -o /dev/null -w '%{http_code}' "https://127.0.0.1:${TUNNEL_PORT}/api/system/status" || true)"
  [ "$status" = "200" ] && ok "Tunnel vers Portainer (${PORTAINER_LOCAL}) opérationnel." \
    || die "Portainer ne répond pas à travers le tunnel (HTTP ${status:-000}). Vérifier qu'il écoute sur ${PORTAINER_LOCAL}."

  # 3. Toute autre destination doit être refusée par permitopen
  # ssh-keyscan à travers le second transfert : il ne doit obtenir aucune bannière SSH.
  if ssh-keyscan -T 5 -p "$((TUNNEL_PORT + 1))" 127.0.0.1 2>/dev/null | grep -q .; then
    die "Le transfert vers 127.0.0.1:${VPS_PORT} (sshd) est accepté : permitopen inopérant."
  fi
  ok "Transfert vers une autre destination refusé."

  ssh -S "$VERIFY_SOCK" -O exit "${VPS_USER}@${VPS_HOST}" >/dev/null 2>&1 || true
  trap - EXIT
  ok "Cloisonnement conforme."
}

cmd_github() {
  require gh
  [ -n "$GH_REPO" ] || die "--repo owner/depot requis pour 'github'."
  [ -f "$KEY_PATH" ] || die "Clé privée absente : $KEY_PATH"
  [ -s "$KNOWN_HOSTS_OUT" ] || die "Empreinte absente : $KNOWN_HOSTS_OUT"
  gh auth status >/dev/null 2>&1 || die "CLI gh non authentifiée (gh auth login)."
  local env url envs
  IFS=',' read -r -a envs <<<"$GH_ENVS"
  for env in "${envs[@]}"; do
    info "Environnement GitHub '${env}' de ${GH_REPO}"
    gh secret set VPS_SSH_KEY         --repo "$GH_REPO" --env "$env" < "$KEY_PATH"
    gh secret set VPS_SSH_KNOWN_HOSTS --repo "$GH_REPO" --env "$env" < "$KNOWN_HOSTS_OUT"
    gh variable set VPS_HOST             --repo "$GH_REPO" --env "$env" --body "$VPS_HOST"
    gh variable set VPS_USER             --repo "$GH_REPO" --env "$env" --body "$VPS_USER"
    gh variable set PORTAINER_LOCAL_ADDR --repo "$GH_REPO" --env "$env" --body "$PORTAINER_LOCAL"
    url=""
    [ "$env" = "production" ] && url="$APP_URL_PRODUCTION"
    [ "$env" = "staging" ] && url="$APP_URL_STAGING"
    if [ -n "$url" ]; then gh variable set APP_URL --repo "$GH_REPO" --env "$env" --body "$url"
    else warn "APP_URL non défini pour '${env}' (APP_URL_STAGING=...)."; fi
    ok "Secrets VPS_SSH_KEY, VPS_SSH_KNOWN_HOSTS et variables VPS_* poussés."
  done
  warn "Reste à créer à la main, par environnement : le secret PORTAINER_WEBHOOK_ID (UUID du webhook de la stack)."
}

cmd_revoke() {
  local pubfile="${1:-${KEY_PATH}.pub}" blob
  [ -f "$pubfile" ] || die "Clé publique introuvable : $pubfile"
  blob="$(key_blob "$pubfile")"
  info "Révocation de la clé $(ssh-keygen -lf "$pubfile" | awk '{print $2}') sur ${VPS_USER}@${VPS_HOST}"
  confirm "Retirer cette clé de authorized_keys ?" || die "Abandon."
  printf '%s\n' "$blob" | admin_ssh '
    set -eu
    f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0
    IFS= read -r blob
    cp -p "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"
    grep -vF "$blob" "$f" > "$f.tmp" || true
    mv "$f.tmp" "$f"; chmod 600 "$f"
  '
  ok "Clé retirée du VPS. Penser à supprimer ou remplacer le secret VPS_SSH_KEY dans GitHub."
}

cmd_rotate() {
  local stamp old_key
  stamp="$(date +%Y%m%d%H%M%S)"
  old_key="${KEY_PATH}.old.${stamp}"
  [ -f "$KEY_PATH" ] || die "Aucune clé existante à faire tourner : utiliser 'all'."
  info "Rotation : l'ancienne clé est conservée sous ${old_key} jusqu'à la bascule"
  mv "$KEY_PATH" "$old_key"; mv "${KEY_PATH}.pub" "${old_key}.pub"
  cmd_create
  cmd_install
  [ -s "$KNOWN_HOSTS_OUT" ] || cmd_known_hosts
  cmd_verify
  if [ -n "$GH_REPO" ]; then cmd_github
  else warn "Sans --repo, mettre à jour VPS_SSH_KEY dans GitHub avant de poursuivre."; confirm "Secret GitHub mis à jour ?" || die "Rotation suspendue : les deux clés restent actives. Finir avec : revoke --pub ${old_key}.pub"; fi
  cmd_revoke "${old_key}.pub"
  rm -f "$old_key" "${old_key}.pub"
  ok "Rotation terminée."
}

cmd_all() {
  cmd_create
  cmd_install
  cmd_known_hosts
  cmd_verify
  if [ -n "$GH_REPO" ]; then cmd_github; else
    info "Étapes suivantes (ou relancer avec --repo owner/depot --env production,staging) :"
    printf '  gh secret set VPS_SSH_KEY --env production < %s\n' "$KEY_PATH"
    printf '  gh secret set VPS_SSH_KNOWN_HOSTS --env production < %s\n' "$KNOWN_HOSTS_OUT"
  fi
  warn "La clé privée ${KEY_PATH} ne doit exister que sur ce poste et dans les secrets GitHub."
  warn "Une fois les secrets poussés, la ranger dans le gestionnaire de secrets puis la supprimer du poste."
}

# --- Analyse des arguments ---------------------------------------------------
[ $# -ge 1 ] || usage 1
CMD="$1"; shift
while [ $# -gt 0 ]; do
  case "$1" in
    --host) VPS_HOST="$2"; shift 2 ;;
    --user) VPS_USER="$2"; shift 2 ;;
    --port) VPS_PORT="$2"; shift 2 ;;
    --key) KEY_PATH="$2"; shift 2 ;;
    --portainer) PORTAINER_LOCAL="$2"; shift 2 ;;
    --admin-identity) ADMIN_IDENTITY="$2"; shift 2 ;;
    --repo) GH_REPO="$2"; shift 2 ;;
    --env) GH_ENVS="$2"; shift 2 ;;
    --staging-url) APP_URL_STAGING="$2"; shift 2 ;;
    --pub) REVOKE_PUB="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "Option inconnue : $1" ;;
  esac
done

case "$CMD" in
  create) cmd_create ;;
  install) cmd_install ;;
  known-hosts) cmd_known_hosts ;;
  verify) cmd_verify ;;
  github) cmd_github ;;
  revoke) cmd_revoke "${REVOKE_PUB:-${KEY_PATH}.pub}" ;;
  rotate) cmd_rotate ;;
  all) cmd_all ;;
  -h|--help|help) usage 0 ;;
  *) die "Sous-commande inconnue : $CMD (voir --help)" ;;
esac
