# Per-service image for the Next.js front end. Build context = repo root
# (`docker build -f deploy/docker/web.Dockerfile .`) so npm workspaces resolve, matching the
# six backend images beside this file.
#
# ⚠️ **`GATEWAY_ORIGIN` is a BUILD argument, not only a runtime variable.** Next evaluates
# `rewrites()` during `next build` and bakes the result into `.next/routes-manifest.json`, so a
# value supplied only at `docker run` would be ignored and every `/api/*` call would be proxied to
# whatever the default was at build time. The symptom would be a login screen that looks perfect
# and cannot reach anything — with nothing in the image to explain why.
#
# Unlike the backend images (which run TypeScript through `tsx`), this one runs a real production
# build: `next dev` recompiles per request and would make the hosted stand feel broken rather than
# slow.
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci

# Where the browser's same-origin `/api` prefix is proxied to. Inside compose the gateway is
# reachable by service name; nothing about the gateway is exposed to the browser.
ARG GATEWAY_ORIGIN=http://gateway:3000
ENV GATEWAY_ORIGIN=${GATEWAY_ORIGIN}
ENV NODE_ENV=production
RUN npm run build --workspace web

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG GATEWAY_ORIGIN=http://gateway:3000
ENV GATEWAY_ORIGIN=${GATEWAY_ORIGIN}
COPY --from=build /app ./
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace", "web"]
