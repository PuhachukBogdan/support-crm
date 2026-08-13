/**
 * The session boundary (feature 027, roadmap 8.6 — `contracts/session-port.md`).
 *
 * Screens import this and nothing else for authentication. They never see a URL, a cookie, a status
 * code or a response body.
 *
 * ── The one rule between this file and the transport ────────────────────────────────────────────
 * **Nothing above this boundary knows a status code.** `423` means nothing on a screen; `locked`
 * does. It also means the day the gateway changes a status, exactly one file changes.
 *
 * ── Why `state()` is not a boolean ──────────────────────────────────────────────────────────────
 * With an httpOnly cookie, "am I signed in?" stops being a local read and becomes a question that
 * is asynchronous and **can fail**. A failure to ask is not a negative answer:
 *
 *   read as `anonymous`     → one network blip signs out the whole floor, mid-ticket
 *   read as `authenticated` → a stranger sees protected chrome
 *
 * The union is exhaustive and has **no default**, so the compiler lists every consumer the day the
 * shape changes (FR-018) instead of a boolean compiling everywhere and being wrong twice.
 */

export type SessionState =
  | { kind: 'resolving' }
  | {
      kind: 'authenticated';
      userId: string;
      accountId: string;
      roles: readonly string[];
      /**
       * Feature 029 — the caller's effective permission keys, as the gateway resolved them.
       *
       * ⛔ **For RENDERING only, never for enforcement.** Every route checks its own key server-side;
       * this list decides what is worth drawing, not what is allowed. A client that lies to itself
       * about it gets refusals, not access.
       *
       * ⚠️ Empty means "none resolved", which is deny-by-default here too — an unknown set must never
       * read as "unknown, so show everything".
       */
      permissionKeys: readonly string[];
    }
  | { kind: 'anonymous' }
  | { kind: 'unreachable' };

/** What a step can answer. Deliberately NOT the HTTP status. */
export type SignInOutcome =
  | { kind: 'code_sent'; challengeId: string; codeExpiresAt: number }
  | { kind: 'rejected' } // wrong password OR unknown address — indistinguishable, by design
  | { kind: 'locked' }
  | { kind: 'unreachable' };

export type CodeOutcome =
  | { kind: 'ok' }
  | { kind: 'bad_code' } // wrong / expired / used / exhausted — the server will not say which
  | { kind: 'unreachable' };

export type InviteStartOutcome =
  | { kind: 'code_sent'; codeExpiresAt: number }
  | { kind: 'rejected' } // bad token OR wrong address — deliberately not separated
  | { kind: 'unreachable' };

/**
 * ⭐ W36 / feature 041 — asking for a recovery link.
 *
 * ⚠️ **There is deliberately NO `rejected` and no `sent_to_unknown`.** The endpoint answers a stranger
 * identically whatever the truth is, so the only outcomes a client can observe are «the product accepted
 * my request» and «I could not ask». A vocabulary with a rejection in it would invite a screen to render
 * one, and that screen would be a directory of who works here.
 */
export type RecoveryRequestOutcome = { kind: 'accepted' } | { kind: 'unreachable' };

/**
 * ⭐ W36 / feature 041 — using the link. ⛔ Note the absence of an `ok` that carries a session: setting a
 * password does not sign anybody in (FR-009), so there is no state here for a screen to mistake for one.
 */
export type RecoveryCompleteOutcome =
  | { kind: 'ok'; revokedCount: number }
  | { kind: 'gone' } // expired or already used — one fact to the person holding it: ask for another
  | { kind: 'rejected' } // not a usable token
  | { kind: 'weak_password'; failures: string[] }
  | { kind: 'not_eligible' }
  | { kind: 'unreachable' };

export type InviteCompleteOutcome =
  | { kind: 'ok' }
  | { kind: 'weak_password' }
  | { kind: 'rejected' }
  | { kind: 'unreachable' };

export interface Session {
  state(): SessionState;
  /**
   * Ask the gateway who this is, and adopt the answer.
   *
   * ⚠️ Added to `contracts/session-port.md` during the build, because the contract as written could
   * not move a session out of `resolving`. `state()` is synchronous on purpose — a screen must be
   * able to read it during a render — so **something has to do the asking**, and the alternatives
   * were worse: an async `state()` puts an await in every consumer, and a side-effecting getter
   * hides a network call behind something that looks like a field read.
   */
  resolve(): Promise<SessionState>;
  signIn(email: string, password: string): Promise<SignInOutcome>;
  /** ⭐ W36 / 041 — ask for a recovery link. Answers the same thing whatever the truth is. */
  requestRecovery(email: string): Promise<RecoveryRequestOutcome>;
  /** ⭐ W36 / 041 — set a password from a link. ⛔ Never returns a session. */
  completeRecovery(token: string, password: string): Promise<RecoveryCompleteOutcome>;
  /**
   * ⭐ W36 / 041 — change your own password, knowing the current one.
   *
   * ⓘ It REUSES `RecoveryCompleteOutcome` rather than declaring a twin, and that is honest rather than
   * lazy: it is the same write with the same answers — `ok` with a session count, `rejected` for the wrong
   * current password, `weak_password`, `not_eligible`, `unreachable`. Only `gone` cannot occur, and a
   * variant that cannot occur is cheaper to leave unreachable than to fork a vocabulary over.
   */
  changePassword(currentPassword: string, newPassword: string): Promise<RecoveryCompleteOutcome>;
  submitCode(challengeId: string, code: string, rememberMe: boolean): Promise<CodeOutcome>;
  startInvite(token: string, email: string): Promise<InviteStartOutcome>;
  completeInvite(
    token: string,
    email: string,
    code: string,
    password: string,
  ): Promise<InviteCompleteOutcome>;
  signOut(): Promise<void>;
}

/**
 * ── The kind lists exist so the vocabulary can be asserted at runtime ───────────────────────────
 * A type disappears at build time, so a test written only against types passes by erasure — it
 * cannot fail, which makes it indistinguishable from no test. These lists are the same vocabulary
 * in a form a test can read, and the `satisfies` checks below make the two disagree loudly rather
 * than silently: adding a variant to a union without adding it here stops compiling.
 */
export const SESSION_STATE_KINDS = [
  'resolving',
  'authenticated',
  'anonymous',
  'unreachable',
] as const satisfies readonly SessionState['kind'][];

export const SIGN_IN_OUTCOME_KINDS = [
  'code_sent',
  'rejected',
  'locked',
  'unreachable',
] as const satisfies readonly SignInOutcome['kind'][];

export const CODE_OUTCOME_KINDS = [
  'ok',
  'bad_code',
  'unreachable',
] as const satisfies readonly CodeOutcome['kind'][];

export const INVITE_START_OUTCOME_KINDS = [
  'code_sent',
  'rejected',
  'unreachable',
] as const satisfies readonly InviteStartOutcome['kind'][];

export const INVITE_COMPLETE_OUTCOME_KINDS = [
  'ok',
  'weak_password',
  'rejected',
  'unreachable',
] as const satisfies readonly InviteCompleteOutcome['kind'][];

export const RECOVERY_REQUEST_OUTCOME_KINDS = [
  'accepted',
  'unreachable',
] as const satisfies readonly RecoveryRequestOutcome['kind'][];

export const RECOVERY_COMPLETE_OUTCOME_KINDS = [
  'ok',
  'gone',
  'rejected',
  'weak_password',
  'not_eligible',
  'unreachable',
] as const satisfies readonly RecoveryCompleteOutcome['kind'][];

export const OUTCOME_KIND_SETS = {
  signIn: SIGN_IN_OUTCOME_KINDS,
  submitCode: CODE_OUTCOME_KINDS,
  startInvite: INVITE_START_OUTCOME_KINDS,
  completeInvite: INVITE_COMPLETE_OUTCOME_KINDS,
  requestRecovery: RECOVERY_REQUEST_OUTCOME_KINDS,
  completeRecovery: RECOVERY_COMPLETE_OUTCOME_KINDS,
} as const;

/**
 * The two directions of agreement between the unions and the lists — both are needed.
 *
 * The `satisfies` on each list above covers one direction: a kind in the list that no variant has
 * stops compiling there. This covers the other, which is the one that matters more: **a variant the
 * list forgot.** Without it, adding a fifth state would leave every runtime test passing against a
 * four-element list that no longer describes the type.
 *
 * `Missing<…>` is `never` when nothing was forgotten, so the record extends `Record<string, never>`
 * and the assertion resolves to `true`. A forgotten variant makes it `false`, and `Assert<false>`
 * fails to compile **naming the offending union**.
 */
type Missing<Union extends string, Listed extends string> = Exclude<Union, Listed>;
type Assert<T extends true> = T;

export type KindListsAreComplete = {
  state: Missing<SessionState['kind'], (typeof SESSION_STATE_KINDS)[number]>;
  signIn: Missing<SignInOutcome['kind'], (typeof SIGN_IN_OUTCOME_KINDS)[number]>;
  submitCode: Missing<CodeOutcome['kind'], (typeof CODE_OUTCOME_KINDS)[number]>;
  startInvite: Missing<InviteStartOutcome['kind'], (typeof INVITE_START_OUTCOME_KINDS)[number]>;
  completeInvite: Missing<
    InviteCompleteOutcome['kind'],
    (typeof INVITE_COMPLETE_OUTCOME_KINDS)[number]
  >;
  // ⭐ W36 / 041 — the two recovery vocabularies join the same completeness assertion, so a variant
  // added to either union without being listed stops compiling and NAMES itself.
  requestRecovery: Missing<
    RecoveryRequestOutcome['kind'],
    (typeof RECOVERY_REQUEST_OUTCOME_KINDS)[number]
  >;
  completeRecovery: Missing<
    RecoveryCompleteOutcome['kind'],
    (typeof RECOVERY_COMPLETE_OUTCOME_KINDS)[number]
  >;
} extends Record<string, never>
  ? true
  : false;

export type _EveryVariantIsListed = Assert<KindListsAreComplete>;
