# 0005 — Web application (desktop wrapper deferred)

**Status:** accepted · **Date:** 2026-07-08

## Decision

Ship as a **web application** (as Chatwoot already is). A desktop wrapper (Tauri/Electron around the same Vue frontend) is kept as a **later option**, not built now.

## Why

- Internal CRM: web gives anywhere-access, zero install, instant updates, and it already exists.
- Desktop's only real advantages (offline, deep OS integration, keeping data out of browsers) are weak for this use case and a large detour.
- If a desktop feel is wanted later, wrapping the existing web frontend in Tauri/Electron is cheap packaging, not an architecture change.
