/**
 * Audit vocabulary shared by every writer and by the federated read surface (feature 015, roadmap 4.8).
 *
 * The audit trail is ONE logical log living in THREE databases: an entry must be written inside the
 * transaction of the action it describes (spec Q3), and a cross-service database write is forbidden
 * (Principle VIII). So the table is duplicated and the vocabulary is shared — from here.
 */
export * from './catalogue';
export * from './detail';
export * from './entry';
export * from './legacy-mapping';
export * from './merge';
