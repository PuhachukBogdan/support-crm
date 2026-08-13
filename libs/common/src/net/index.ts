/**
 * Feature 038: the fail-closed INBOUND address allow-list. ⚠️ Deliberately the opposite default
 * from `mail/guards.ts`, whose empty list means «no restriction» because it narrows an egress.
 */
export * from './ip-allow-list';
