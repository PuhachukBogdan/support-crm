#!/bin/bash
# Per-service database + role provisioning (spec 003-local-infra, US1 / FR-002).
#
# Runs once, as the Postgres superuser, on first container init
# (/docker-entrypoint-initdb.d). Creates ONE database and ONE dedicated login role per
# data-owning service (auth/users/chats/brands), and grants each role CONNECT to ONLY
# its own database (PUBLIC connect revoked) — the local realization of DB-per-service
# isolation. Role passwords come from the container ENVIRONMENT (compose injects them
# from .env); there are NO hardcoded credentials here (FR-005).
#
# gateway (stateless routing) and worker (queue-only) intentionally get NO database.
set -euo pipefail

# service:password-env-var pairs
services=(
  "auth:AUTH_DB_PASSWORD"
  "users:USERS_DB_PASSWORD"
  "chats:CHATS_DB_PASSWORD"
  "brands:BRANDS_DB_PASSWORD"
)

for entry in "${services[@]}"; do
  svc="${entry%%:*}"
  pw_var="${entry##*:}"
  pw="${!pw_var:-}"
  if [ -z "$pw" ]; then
    echo "FATAL: $pw_var is unset — refusing to create role '${svc}_user' with an empty password" >&2
    exit 1
  fi
  db="${svc}_db"
  role="${svc}_user"

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "postgres" <<-SQL
    CREATE ROLE ${role} LOGIN PASSWORD '${pw}';
    CREATE DATABASE ${db} OWNER ${role};
    -- Isolation: only this role may connect to this database.
    REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${db} TO ${role};
SQL
  echo "provisioned database '${db}' owned by isolated role '${role}'"
done

echo "per-service database provisioning complete (auth, users, chats, brands)"
