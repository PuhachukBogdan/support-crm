/**
 * @crm/common/policy — the shared, stateless RBAC policy library (feature 011). The single place
 * both the gateway edge and the owning services consult to decide authorization + field masking,
 * so a bypass of one tier is still caught by the other (Principle II). No I/O, no DB, no Nest.
 */
export * from './permission';
export * from './view-as';
export * from './field-tiers';
