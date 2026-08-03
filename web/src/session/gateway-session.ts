import { createFetchPort, type HttpPort, type HttpResponse } from '../data/gateway/http-port';
import { withRefreshRotation } from '../data/gateway/rotating-port';
import type {
  CodeOutcome,
  InviteCompleteOutcome,
  InviteStartOutcome,
  Session,
  SessionState,
  SignInOutcome,
} from './session';

/**
 * T014 [027] — the gateway-backed session (`data-model.md` §4).
 *
 * ── The rule this file exists to hold ───────────────────────────────────────────────────────────
 * ⚠️ **A transport failure becomes `unreachable`, never `rejected`.** Presenting a dead gateway as
 * a wrong password sends a person to fix a password that was never broken — and, once recovery
 * exists, to do it repeatedly while the real fault goes unreported (FR-014). Every mapping below
 * therefore starts from the failure case, not from the success case.
 *
 * ── It reads the STATUS and never the body ──────────────────────────────────────────────────────
 * Recorded off the live gateway: the controller-produced refusals answer `{status: …}`, but
 * `GET /auth/me` refused by the global guard answers Nest's `{message, statusCode}` — a different
 * shape on the route this session asks most. Any code branching on the body would be right four
 * times and wrong on the fifth. See `../data/gateway/fixtures/README.md`.
 *
 * ── `resolve()` is on the class, and the contract needed it ─────────────────────────────────────
 * `contracts/session-port.md` lists `state()` and the five verbs. Building it showed the list is
 * incomplete: `state()` is synchronous by design (a screen must be able to read it during a
 * render), so **something has to do the asking**. Making `state()` itself asynchronous would put an
 * await in every consumer; making it side-effecting would hide a network call behind a getter.
 * `resolve()` is the missing member, and the contract has been amended rather than worked around.
 */
export class GatewaySession implements Session {
  private current: SessionState = { kind: 'resolving' };

  constructor(private readonly http: HttpPort = withRefreshRotation(createFetchPort())) {}

  state(): SessionState {
    return this.current;
  }

  /** Ask the gateway who this is. The ONLY authority — the browser never decides (Principle II). */
  async resolve(): Promise<SessionState> {
    const res = await this.send({ path: '/auth/me' });
    this.current = this.stateFor(res);
    return this.current;
  }

  async signIn(email: string, password: string): Promise<SignInOutcome> {
    const res = await this.send({ path: '/auth/login', method: 'POST', body: { email, password } });
    if (this.failedToAsk(res)) return { kind: 'unreachable' };
    if (res.status === 200) {
      const body = res.body as { challengeId?: unknown; codeExpiresAt?: unknown };
      // A 200 whose body does not carry a challenge is not a success we can continue from. It is
      // reported as unreachable rather than rejected: nothing about the credentials was learnt.
      if (typeof body?.challengeId !== 'string' || typeof body.codeExpiresAt !== 'number') {
        return { kind: 'unreachable' };
      }
      return {
        kind: 'code_sent',
        challengeId: body.challengeId,
        // ⚠️ UNIX **seconds** (`otp.service.ts`: `Math.floor(getTime()/1000)`), not milliseconds.
        // Carried through unconverted, and the one place that compares it says so.
        codeExpiresAt: body.codeExpiresAt,
      };
    }
    if (res.status === 423) return { kind: 'locked' };
    if (res.status === 401) return { kind: 'rejected' };
    return { kind: 'unreachable' };
  }

  async submitCode(challengeId: string, code: string, rememberMe: boolean): Promise<CodeOutcome> {
    const res = await this.send({
      path: '/auth/verify',
      method: 'POST',
      body: { challengeId, code, rememberMe },
    });
    if (this.failedToAsk(res)) return { kind: 'unreachable' };
    if (res.status === 200) return { kind: 'ok' };
    if (res.status === 401) return { kind: 'bad_code' };
    return { kind: 'unreachable' };
  }

  async startInvite(token: string, email: string): Promise<InviteStartOutcome> {
    const res = await this.send({
      path: '/auth/register/start',
      method: 'POST',
      body: { token, email },
    });
    if (this.failedToAsk(res)) return { kind: 'unreachable' };
    if (res.status === 200) {
      const body = res.body as { codeExpiresAt?: unknown };
      if (typeof body?.codeExpiresAt !== 'number') return { kind: 'unreachable' };
      return { kind: 'code_sent', codeExpiresAt: body.codeExpiresAt };
    }
    if (res.status === 401) return { kind: 'rejected' };
    return { kind: 'unreachable' };
  }

  async completeInvite(
    token: string,
    email: string,
    code: string,
    password: string,
  ): Promise<InviteCompleteOutcome> {
    const res = await this.send({
      path: '/auth/register/complete',
      method: 'POST',
      body: { token, email, code, password },
    });
    if (this.failedToAsk(res)) return { kind: 'unreachable' };
    if (res.status === 200) return { kind: 'ok' };
    if (res.status === 422) return { kind: 'weak_password' };
    if (res.status === 401) return { kind: 'rejected' };
    return { kind: 'unreachable' };
  }

  /**
   * End the session ON THE SERVER (FR-005). Clearing a cookie the page cannot read is not something
   * the browser can do anyway — but the point is stronger than that: a session that ends only in
   * this tab is still a live credential everywhere else it was copied to.
   */
  async signOut(): Promise<void> {
    await this.send({ path: '/auth/logout', method: 'POST' });
    // Local state follows the request unconditionally. If the call failed, the person still asked
    // to leave, and the next resolve() will find out what the server thinks.
    this.current = { kind: 'anonymous' };
  }

  /** A thrown transport error is normalised to the same "could not ask" the adapter reports. */
  private async send(req: Parameters<HttpPort>[0]): Promise<HttpResponse> {
    try {
      return await this.http(req);
    } catch {
      return { status: 0, body: undefined };
    }
  }

  /**
   * The question could not be asked. Status 0 is this codebase's "the request never completed";
   * 5xx is the gateway answering that it cannot answer. Both are the service, not the credentials.
   */
  private failedToAsk(res: HttpResponse): boolean {
    return res.status === 0 || res.status >= 500;
  }

  private stateFor(res: HttpResponse): SessionState {
    if (this.failedToAsk(res)) return { kind: 'unreachable' };
    if (res.status !== 200) return { kind: 'anonymous' };
    const body = res.body as {
      userId?: unknown;
      accountId?: unknown;
      roles?: unknown;
      permissionKeys?: unknown;
    };
    // A 200 without an identity is not an identity. Treated as "could not ask" rather than as a
    // signed-out answer, because the server did not say the session was over.
    if (typeof body?.userId !== 'string' || typeof body.accountId !== 'string') {
      return { kind: 'unreachable' };
    }
    return {
      kind: 'authenticated',
      userId: body.userId,
      accountId: body.accountId,
      roles: Array.isArray(body.roles) ? (body.roles as string[]).filter((r) => typeof r === 'string') : [],
      // Feature 029. Absent ⇒ empty, never "unknown so allow": the shell and the Inbox both decide
      // what to DRAW from this list, and a permissive default would draw an admin's controls for
      // everyone the moment the field went missing.
      permissionKeys: Array.isArray(body.permissionKeys)
        ? (body.permissionKeys as string[]).filter((k) => typeof k === 'string')
        : [],
    };
  }
}
