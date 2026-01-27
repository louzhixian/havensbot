# syntax=docker/dockerfile:1.5
FROM node:20-slim AS build
WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY apps ./apps
COPY prompts ./prompts

ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public

RUN npx prisma generate
RUN --mount=type=cache,target=/root/.npm \
  --mount=type=cache,target=/app/.tsbuildinfo \
  bash -lc 'if [ ! -f dist/index.js ]; then rm -f /app/.tsbuildinfo/tsconfig.tsbuildinfo; fi; npm run build'

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y \
  && apt-get install -y openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prompts ./prompts
COPY package.json ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/arkcore-entrypoint
RUN chmod +x /usr/local/bin/arkcore-entrypoint

ENTRYPOINT ["arkcore-entrypoint"]
