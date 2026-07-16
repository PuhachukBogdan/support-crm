# Per-service image for the Worker (background jobs). Build context = repo root. Phase 0:
# proves the image builds (SC-005); runs the bootable shell via tsx. BullMQ jobs: Phase 1+.
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
CMD ["npx", "tsx", "--tsconfig", "services/worker/tsconfig.json", "services/worker/src/main.ts"]
