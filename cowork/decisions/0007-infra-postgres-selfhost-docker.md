# 0007 — PostgreSQL + Redis, self-hosted on our own server via Docker

> 🔄 **Updated by 0023 (2026-07-08):** the Postgres is now provided by **self-hosted Supabase** (Postgres + auth + storage), still on our own infra/Docker. Redis (for BullMQ) remains ours. Self-host / data-in-house stance unchanged.

**Status:** accepted · **Date:** 2026-07-08

## Decision

Keep **PostgreSQL** as the database (evolving Chatwoot's existing ~89-table schema) and **Redis** (Sidekiq jobs + ActionCable real-time). Host the whole system **on our own server via Docker Compose**. Not Supabase, not managed cloud, not Kubernetes.

## Why

- Keeping Rails (0001) means keeping its Postgres + Redis stack; no reason to swap.
- Self-hosting keeps all data in-house (our data-ownership principle) and is simple and cheap at internal-CRM scale. Chatwoot already ships Docker Compose files.
- Managed cloud puts data at a provider and adds cost/moving parts; Kubernetes is overkill.

## Security findings that land here (from security/findings.md)

- **SEC-6** — remove the silent default DB password; fail closed if unset.
- **SEC-7** — enforce HTTPS + secure cookies.
- **SEC-19** — run containers as non-root; pin image versions (no `latest`).
- **SEC-20** — implement encrypted DB backups to off-host storage (no backup tooling exists today).
- **Egress allow-list** — enforce at the server firewall so data can't leave except to approved destinations (see external-data-flows.md).

## Consequences

- Ops (backups, TLS, firewall/egress) are our responsibility — acceptable at this scale, and required before real data (Category-1 gate).
- Scale-out (separate DB host, more app nodes) is a later option; when DB moves off-host, revisit SEC-22 (connection encryption).
