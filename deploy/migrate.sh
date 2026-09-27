#!/bin/sh
# Migrations + rotation des mots de passe de rôles. (Phase A)
#
# Lancé comme job one-shot par la stack (service `migrate`). Deux temps :
#   1. applique le schéma et crée les rôles (migrate deploy)
#   2. remplace les mots de passe de TEST des rôles par les secrets réels
#
# Sans l'étape 2, les rôles applicatifs garderaient les valeurs publiques du
# dépôt (`lsi_app_test_pwd`…). Elle est donc OBLIGATOIRE au déploiement.
set -eu
cd /app

# Fail-fast : un secret absent ferait tourner l'ALTER ROLE avec un mot de passe
# vide. Le job échoue alors, et app/worker (service_completed_successfully)
# ne démarrent pas : mieux vaut une stack arrêtée qu'une base ouverte.
: "${DATABASE_URL:?DATABASE_URL manquant}"
for var in LSI_APP_PASSWORD LSI_WEBHOOK_PASSWORD LSI_SCHEDULER_PASSWORD; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "✗ $var est vide ou absent de l'environnement de la stack." >&2
    exit 1
  fi
  case "$val" in
    *"'"*|*"\\"*)
      echo "✗ $var contient une apostrophe ou une barre oblique inverse : refusé (interpolé en SQL)." >&2
      exit 1
      ;;
  esac
done

echo "→ Application des migrations Prisma…"
pnpm --filter @lsi/persistence exec prisma migrate deploy

echo "→ Rotation des mots de passe des rôles applicatifs…"
# ⚠ Les mots de passe sont interpolés dans du SQL : ils NE DOIVENT PAS
# contenir d'apostrophe. Recommandé : alphanumérique + symboles hors quotes,
# ≥ 32 caractères. Générables par `openssl rand -base64 32 | tr -d '/+='`.
cat <<SQL | pnpm --filter @lsi/persistence exec prisma db execute --url "$DATABASE_URL" --stdin
ALTER ROLE lsi_app       LOGIN PASSWORD '${LSI_APP_PASSWORD}';
ALTER ROLE lsi_webhook   LOGIN PASSWORD '${LSI_WEBHOOK_PASSWORD}';
ALTER ROLE lsi_scheduler LOGIN PASSWORD '${LSI_SCHEDULER_PASSWORD}';
SQL

# Lot 9 — données de référence du tenant (annexe C) : modèles de proposition et
# bibliothèque de contenus. Idempotent (UNCHANGED au second passage), ne réécrit
# jamais un modèle modifié dans l'interface. Un fichier invalide ou un cas de
# contrôle chiffré en échec fait échouer CE job : app et worker ne démarrent
# pas (service_completed_successfully) et le déploiement est annulé.
if [ "${SEED_PROPOSAL_TEMPLATES:-false}" = "true" ]; then
  echo "→ Seed des modèles de proposition (tenant ${SEED_TENANT_SLUG:-lsi})…"
  pnpm --filter @lsi/persistence exec tsx prisma/seed.ts --only=propositions
fi

echo "✓ Migrations appliquées et mots de passe de rôles renouvelés."
