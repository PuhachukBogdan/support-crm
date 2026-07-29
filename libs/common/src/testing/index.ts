/**
 * Shared infrastructure for STRUCTURAL GUARDS — tests that assert something about the source itself
 * rather than about behaviour.
 *
 * Nothing here is product code and nothing here runs in a service. It lives in `@crm/common` because
 * the guards that need it are spread across `services/`, `libs/` and the root `tests/` tree, and a
 * detector copied three times is a detector that is wrong in at least one of them.
 */
export * from './strip-comments';
