/**
 * The operator UI-preference vocabulary (feature 021, roadmap 5.6).
 *
 * Lives in `@crm/common` for the same reason the upload purposes and export scopes do: more than one
 * workspace needs it and it must not drift. `users` validates and stores against it; the settings
 * screen (8.7–8.9) will render from it; the server-rendered first paint (8.8) needs its defaults.
 * Feature 017 found two copies of an export vocabulary that had already diverged before anyone
 * noticed — one source is the fix.
 *
 * ⚠️ This is the OPERATOR's appearance, not `Player.preferences_json` (the customer's VIP portfolio
 * data, tier `am_only`). See the header of `ui-preferences.ts`.
 */
export * from './ui-preferences';
