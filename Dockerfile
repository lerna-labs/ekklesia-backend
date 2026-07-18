# syntax=docker/dockerfile:1.7
#
# Runtime config (SERVER_PORT, MONGODB_*, JWT_*, HYDRA_*, ...) is not baked
# into this image. It's supplied at deploy time via NODE_ENV plus whatever
# mechanism ships the matching .env.$NODE_ENV file / process env into the
# running container. The PM2 ecosystem files in the repo root are process
# managers for bare-metal deploys, not part of this image.

# ---- deps: full install against the lockfile (resolves once; also the
#      hook point for a future build/bundle step if one shows up) ----
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm ci

# ---- runtime: prune the resolved install down to production deps only,
#      on a slim base image ----
FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=deps /app/package.json /app/package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
