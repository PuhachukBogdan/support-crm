# Per-service image for the Brands service. Build context = repo root. Phase 0: proves the
# image builds (SC-005); runs the bootable shell via tsx. Real build/runtime hardening: Phase 13.
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
CMD ["npx", "tsx", "--tsconfig", "services/brands/tsconfig.json", "services/brands/src/main.ts"]
