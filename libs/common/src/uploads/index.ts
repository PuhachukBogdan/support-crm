/**
 * Shared upload vocabulary (feature 016, roadmap 4.9).
 *
 * Lives in `@crm/common` because the gateway and `users` both need it and it must not drift: the
 * gateway resolves the parse limit and the first-tier permission from the purpose catalogue, and
 * `users` enforces the same entry independently (Principle II). Two copies of a size cap is one
 * copy that is wrong.
 *
 * Nothing here touches bytes on disk, credentials or a network. Everything that does lives in
 * `services/users/src/uploads/`, and a structural test keeps it there (research R9).
 */
export * from './purposes';
export * from './content-type';
export * from './filename';
