# Per-service image for the API Gateway. Build context = repo root (`docker build -f
# deploy/docker/gateway.Dockerfile .`) so npm workspaces resolve. Phase 0 proves the
# image *builds* (SC-005); it runs the TS entrypoint via tsx (a compiled production build
# is Phase 13, alongside k8s manifests).
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npx", "tsx", "--tsconfig", "services/gateway/tsconfig.json", "services/gateway/src/main.ts"]
