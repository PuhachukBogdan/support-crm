# Per-service image for the Auth service. Build context = repo root. Phase 0: proves the
# image builds (SC-005); runs the bootable shell via tsx. Real build/runtime hardening: Phase 13.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci

FROM node:22-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app ./
CMD ["npx", "tsx", "--tsconfig", "services/auth/tsconfig.json", "services/auth/src/main.ts"]
