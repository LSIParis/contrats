#!/usr/bin/env bash
# Provisionne l'instance DocuSeal locale et récupère une clé API.
#
# DocuSeal n'offre pas d'installation « headless » : le premier compte se
# crée via son assistant web. Ce script rejoue ce formulaire pour rendre la
# pile de développement reproductible — sans quoi chaque développeur devrait
# cliquer dans une interface avant de pouvoir lancer les tests d'intégration.
#
# Usage : ./scripts/setup-docuseal.sh
# Écrit DOCUSEAL_API_KEY dans .env.docuseal (git-ignoré).

# Pas de `pipefail` global : chaque extraction est un pipeline
# `curl | grep | sed`, et un grep sans correspondance ferait mourir le script
# AVANT le message d'erreur qui explique quoi faire. Les extractions portent
# leur propre `|| true` et sont vérifiées explicitement.
set -euo pipefail
set +o pipefail

DOCUSEAL_URL="${DOCUSEAL_URL:-http://localhost:3002}"
ADMIN_EMAIL="${DOCUSEAL_ADMIN_EMAIL:-dev@lsi-maintenance.fr}"
ADMIN_PASSWORD="${DOCUSEAL_ADMIN_PASSWORD:-DevPassword123!}"
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

echo "→ DocuSeal : $DOCUSEAL_URL"

# --- Déjà installé ? --------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIES" "$DOCUSEAL_URL/setup")
if [ "$code" = "302" ] || [ "$code" = "404" ]; then
  echo "→ Instance déjà installée, connexion…"
else
  echo "→ Installation initiale…"
  token=$(curl -s -c "$COOKIES" "$DOCUSEAL_URL/setup" \
    | grep -oE 'name="authenticity_token" value="[^"]+"' \
    | head -1 | sed -E 's/.*value="([^"]+)".*/\1/' || true)

  if [ -z "$token" ]; then
    echo "✗ Jeton CSRF introuvable sur /setup" >&2
    exit 1
  fi

  curl -s -o /dev/null -b "$COOKIES" -c "$COOKIES" -X POST "$DOCUSEAL_URL/setup" \
    --data-urlencode "authenticity_token=$token" \
    --data-urlencode "user[email]=$ADMIN_EMAIL" \
    --data-urlencode "user[password]=$ADMIN_PASSWORD" \
    --data-urlencode "user[first_name]=Dev" \
    --data-urlencode "user[last_name]=LSI" \
    --data-urlencode "account[name]=LSI Maintenance (dev)" \
    --data-urlencode "account[timezone]=Europe/Paris" \
    --data-urlencode "account[locale]=fr-FR"
fi

# --- Connexion --------------------------------------------------------
token=$(curl -s -b "$COOKIES" -c "$COOKIES" "$DOCUSEAL_URL/sign_in" \
  | grep -oE 'name="authenticity_token" value="[^"]+"' \
  | head -1 | sed -E 's/.*value="([^"]+)".*/\1/')

if [ -n "$token" ]; then
  curl -s -o /dev/null -b "$COOKIES" -c "$COOKIES" -X POST "$DOCUSEAL_URL/sign_in" \
    --data-urlencode "authenticity_token=$token" \
    --data-urlencode "user[email]=$ADMIN_EMAIL" \
    --data-urlencode "user[password]=$ADMIN_PASSWORD"
fi

# --- Clé API ----------------------------------------------------------
api_key=$(curl -s -b "$COOKIES" "$DOCUSEAL_URL/api" \
  | grep -oE '\b[a-zA-Z0-9]{40,64}\b' | head -1 || true)

if [ -z "$api_key" ]; then
  api_key=$(curl -s -b "$COOKIES" "$DOCUSEAL_URL/api_settings" \
    | grep -oE '\b[a-zA-Z0-9]{40,64}\b' | head -1 || true)
fi

if [ -z "$api_key" ]; then
  echo "✗ Clé API introuvable. Connectez-vous à $DOCUSEAL_URL ($ADMIN_EMAIL / $ADMIN_PASSWORD)" >&2
  echo "  puis relevez la clé dans Settings → API." >&2
  exit 1
fi

# .env.docuseal est git-ignoré : jamais de secret dans le dépôt (§13.5).
cat > .env.docuseal <<EOF
# Généré par scripts/setup-docuseal.sh — NE PAS COMMITER.
DOCUSEAL_URL="$DOCUSEAL_URL/api"
DOCUSEAL_API_KEY="$api_key"
EOF

echo "✓ Clé API écrite dans .env.docuseal"
echo "  Interface : $DOCUSEAL_URL ($ADMIN_EMAIL / $ADMIN_PASSWORD)"
