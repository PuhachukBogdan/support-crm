export type {
  Session,
  SessionState,
  SignInOutcome,
  CodeOutcome,
  InviteStartOutcome,
  InviteCompleteOutcome,
} from './session';
export {
  SESSION_STATE_KINDS,
  SIGN_IN_OUTCOME_KINDS,
  CODE_OUTCOME_KINDS,
  INVITE_START_OUTCOME_KINDS,
  INVITE_COMPLETE_OUTCOME_KINDS,
  OUTCOME_KIND_SETS,
} from './session';
export { GatewaySession } from './gateway-session';
export { SessionProvider } from './session-provider';
export type { SessionContextValue } from './session-context';
export { useSession, getSession, setSession } from './use-session';
export { SessionGuard } from './session-guard';

// ⚠️ `session-seed.ts` is NOT exported here on purpose: it imports `next/headers` and is
// server-only. Re-exporting it would pull server code into every client bundle that touches the
// session — which is most of them.
