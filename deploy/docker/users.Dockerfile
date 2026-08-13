# Per-service image for the Users service. Build context = repo root. Phase 0: proves the
# image builds (SC-005); runs the bootable shell via tsx. Real build/runtime hardening: Phase 13.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci

# ⚠️ **`npm ci` does NOT fail when an OPTIONAL dependency fails to install** — that is npm's
# documented behaviour, and `sharp` is delivered entirely through optional platform packages. So a
# single flaky tarball fetch yields a build that reports success, an image that ships, and a service
# that crash-loops on boot with `ERR_DLOPEN_FAILED: libvips-cpp.so…` — an error that reads like a
# broken dependency rather than a broken build.
#
# Not hypothetical: it happened on 2026-08-13 (W31). `@img/sharp-linux-x64` installed, its sibling
# `@img/sharp-libvips-linux-x64` did not, the build exited 0, and `users` restarted 28 times on the
# verification stand while every local check was green. An identical rebuild moments later was fine —
# which is the worst property of all, because it makes the failure look like the stand's fault.
#
# One line turns a boot-time crash into a build-time refusal.
RUN node -e "require('sharp'); console.log('sharp: native binding OK')"

FROM node:22-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app ./
CMD ["npx", "tsx", "--tsconfig", "services/users/tsconfig.json", "services/users/src/main.ts"]
