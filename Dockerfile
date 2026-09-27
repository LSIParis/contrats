# syntax=docker/dockerfile:1
#
# Image unique de l'application « Contrats » : API (app), worker et job de
# migration tournent sur CETTE image, seule la commande change. Les deux
# processus applicatifs exécutent donc exactement la même version.
#
#   app     : CMD par défaut → src/main.ts
#   worker  : pnpm --filter @lsi/api exec node --import @swc-node/register/esm-register src/worker.ts
#   migrate : sh /app/deploy/migrate.sh
#
# Arguments de build (fournis par release.yml / ci.yml, annexe A) :
#   APP_VERSION  version SemVer (ou « main », « ci ») → ENV APP_VERSION, /healthz.version
#   GIT_SHA      SHA complet du commit              → ENV GIT_SHA,     /healthz.revision
#   SOURCE_URL   dépôt, pour le label OCI qui rattache le paquet GHCR au dépôt
#
# Aucun secret n'entre dans l'image : tout arrive par l'environnement de la
# stack Portainer à l'exécution. `.dockerignore` écarte les .env*.
#
# Choix assumé : l'app est exécutée en TypeScript à la volée via SWC
# (@swc-node/register) plutôt que compilée en JS. Le monorepo expose ses
# packages en source (`"main": "./src/index.ts"`), donc un build tsc complet
# demanderait de reconfigurer les exports de chaque package vers dist.
#
# ⚠ PAS tsx : esbuild (que tsx utilise) N'ÉMET PAS les métadonnées de
# décorateurs, dont NestJS a besoin pour l'injection. Un smoke test l'a
# prouvé — l'app démarrait mais répondait 500 sur chaque requête, le guard
# global recevant un Reflector undefined. SWC émet ces métadonnées
# (emitDecoratorMetadata, piloté par le tsconfig). Divergence dev/prod évitée :
# start:dev utilise aussi SWC.
#
# ⚠ cwd : `pnpm --filter @lsi/api exec …` lance node avec cwd = /app/apps/api,
# PAS /app. C'est voulu (SWC y trouve apps/api/tsconfig.json, donc
# emitDecoratorMetadata), mais tout chemin résolu depuis process.cwd() vise
# /app/apps/api/… : résoudre depuis import.meta.url (cf. ServeStatic dans
# app.module.ts, qui a servi un SPA inexistant pour cette raison).

# ---- base commune -----------------------------------------------------
# Image épinglée par digest (comme les actions par SHA) ; Dependabot
# (écosystème docker) met à jour tag et digest ensemble.
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS base
WORKDIR /app
# Prisma a besoin d'openssl ; ca-certificates pour les appels HTTPS sortants
# (DocuSeal, Perplexity, Anthropic). curl pour le HEALTHCHECK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# corepack est absent/instable selon les images : pnpm via npm, version figée
# (alignée sur "packageManager" du package.json racine).
RUN npm install -g pnpm@9.15.9 && npm cache clean --force

# ---- manifestes -------------------------------------------------------
# On extrait TOUS les package.json du workspace (apps/*, packages/*), sans
# les lister à la main : un nouveau paquet ne casse pas l'install figée. La
# couche produite ne change que si un manifeste change → cache des deps.
FROM base AS manifests
COPY . /src
RUN cd /src \
 && find . -name package.json -not -path '*/node_modules/*' \
    | xargs -I{} sh -c 'mkdir -p "/manifests/$(dirname "{}")" && cp "{}" "/manifests/{}"' \
 && cp pnpm-lock.yaml pnpm-workspace.yaml /manifests/

# ---- dépendances ------------------------------------------------------
FROM base AS deps
COPY --from=manifests /manifests/ ./
RUN pnpm install --frozen-lockfile

# ---- génération du client Prisma + build du SPA -----------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @lsi/persistence exec prisma generate
# Build du SPA : servi même origine par NestJS (ServeStaticModule, app.module.ts).
RUN pnpm --filter @lsi/web build
# Dépendances de PRODUCTION seulement : outils de développement et de test
# (vitest, esbuild, tsx, eslint…) absents de l'image — surface d'attaque et
# alertes de sécurité en moins. Le CLI Prisma reste (dépendance de production
# de @lsi/persistence) : le job `migrate` l'utilise. Le client Prisma est
# régénéré par le postinstall de @lsi/persistence.
# (Réinstallation à partir de zéro : `install --prod` seul laisse les paquets de
# développement dans node_modules/.pnpm, où les scanners les voient encore.)
RUN find . -name node_modules -type d -prune -exec rm -rf {} +  && pnpm install --frozen-lockfile --prod --offline
# Le runtime n'a besoin ni des sources ni des deps du front (seulement dist/).
RUN rm -rf apps/web/node_modules apps/web/src

# ---- image finale -----------------------------------------------------
FROM base AS runtime

ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG SOURCE_URL=https://github.com/LSIParis/contrats

LABEL org.opencontainers.image.title="contrats" \
      org.opencontainers.image.description="Gestion du cycle de vie des contrats clients" \
      org.opencontainers.image.vendor="LSI-Maintenance" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

# Version et révision lues par /healthz (contrat de l'annexe A).
ENV NODE_ENV=production \
    PORT=3001 \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# node_modules (avec le client Prisma généré), sources exécutées par SWC,
# SPA compilé et script de migration. Propriété root, lecture seule pour
# l'utilisateur d'exécution : le process ne peut pas réécrire son code.
COPY --from=build /app ./

EXPOSE 3001

# Utilisateur non-root : aucun process de l'image n'a besoin de root.
USER node

# /healthz est public (@Public) et ne touche ni la base ni DocuSeal : il dit
# « le process sert », pas « tout l'écosystème va bien » (c'est /readyz).
# Forme shell pour que ${PORT} soit résolu à l'exécution. Le worker n'a pas de
# serveur HTTP : son healthcheck est désactivé dans la stack.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# Les migrations NE sont PAS lancées ici : un `migrate deploy` par réplique
# serait une course. Elles tournent dans le job one-shot `migrate` de la stack
# (deploy/migrate.sh). L'image applicative ne fait que servir.
CMD ["pnpm", "--filter", "@lsi/api", "exec", "node", "--import", "@swc-node/register/esm-register", "src/main.ts"]
