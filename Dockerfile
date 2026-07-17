# Image de l'API LSI Contrats. (Phase A du plan de déploiement)
#
# Multi-stage : on installe et on génère le client Prisma dans des étapes
# jetables, l'image finale ne porte que ce qui tourne.
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

# ---- base commune -----------------------------------------------------
FROM node:22-slim AS base
WORKDIR /app
# Prisma a besoin d'openssl ; ca-certificates pour les appels HTTPS sortants
# (DocuSeal, SES). curl pour le healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# corepack est absent/instable selon les images : pnpm via npm, version figée.
RUN npm install -g pnpm@9.15.9

# ---- dépendances ------------------------------------------------------
# On copie d'abord les seuls manifestes : le cache de couche des deps n'est
# invalidé que si un package.json change, pas à chaque modif de code.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/domain/package.json ./packages/domain/
COPY packages/persistence/package.json ./packages/persistence/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

# ---- génération du client Prisma -------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @lsi/persistence exec prisma generate

# ---- image finale -----------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3001
# node_modules (avec le client Prisma généré) + source.
COPY --from=build /app ./
EXPOSE 3001

# Utilisateur non-root : le process API n'a aucune raison de tourner en root.
USER node

# Le healthcheck cible /health, qui est @Public() (§ guard global).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

# Les migrations NE sont PAS lancées ici : un `migrate deploy` par réplique
# serait une course. Elles tournent dans un job one-shot au déploiement
# (voir deploy/). L'image applicative ne fait que servir.
CMD ["pnpm", "--filter", "@lsi/api", "exec", "node", "--import", "@swc-node/register/esm-register", "src/main.ts"]
