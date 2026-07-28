/**
 * Shared export vocabulary (feature 017, roadmap 4.10).
 *
 * Lives in `@crm/common` because two services must agree on it and must not drift: the gateway
 * validates the scope name and resolves its permission key, and `chats` executes the row. Two copies
 * of a row limit is one copy that is wrong — the same reasoning that put the upload purposes here.
 *
 * Nothing here touches a database, a network or bytes on disk. The producer lives in
 * `services/chats/src/export/`, and the artefact only ever reaches storage through the single
 * validated path in `services/users/src/uploads/` (research R4).
 */
export * from './scopes';
export * from './csv';
