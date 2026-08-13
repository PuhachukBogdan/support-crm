/**
 * The ONLY place in this product where message wording exists (feature 028, contracts §3).
 *
 * ── Why one module, and why it is worth enforcing ───────────────────────────────────────────────
 * Wording that lives in two places diverges, and the divergence is invisible until somebody reads
 * both. More importantly, a single renderer is what makes FR-009 checkable: a structural test can
 * assert that no company name exists *here*, and that assertion covers the whole product only
 * because there is nowhere else to write a sentence.
 *
 * ── Plain text, no images, no remote content (FR-007) ───────────────────────────────────────────
 * A one-time code must not require loading a remote asset. That is a read receipt on an
 * authentication event, and it degrades in exactly the hardened mail clients corporate staff use.
 *
 * ⚠️ **The brand is a VALUE with a neutral default** (Principle VI). An authentication email is the
 * least visible place a brand hides and the worst place for a licensee to discover ours.
 */

export interface RenderedMessage {
  subject: string;
  text: string;
}

export interface LoginCodePayload {
  code: string;
  /** Milliseconds since the epoch. Formatted for a human below; never sent as a raw number. */
  expiresAtMs: number;
}

export interface InvitationPayload {
  inviteToken: string;
  expiresAtMs: number;
}

export interface RecoveryPayload {
  recoveryToken: string;
  expiresAtMs: number;
}

export interface RenderContext {
  brandName: string;
  /** No trailing slash. Validated as a URL by the config gate. */
  appBaseUrl: string;
}

/** UTC, spelled out. A local time would be the SERVER's local time, which is nobody's. */
function formatDeadline(ms: number): string {
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function minutesUntil(ms: number, now: number): number {
  return Math.max(1, Math.round((ms - now) / 60_000));
}

/**
 * ⚠️ **No link. Not one.** A "sign in" button in a message that also carries the code turns a
 * forwarded email into a session (FR-011). The code is in the subject as well as the body on
 * purpose: it is the one thing the person needs, and it is visible from the notification without
 * opening anything.
 */
export function renderLoginCode(
  payload: LoginCodePayload,
  ctx: RenderContext,
  now: number = Date.now(),
): RenderedMessage {
  const minutes = minutesUntil(payload.expiresAtMs, now);
  return {
    subject: `${ctx.brandName} sign-in code: ${payload.code}`,
    text: [
      payload.code,
      '',
      'This code completes a sign-in that was just started.',
      `It stops working at ${formatDeadline(payload.expiresAtMs)} (about ${minutes} minutes).`,
      '',
      'If you did not start it, you can ignore this message — the code alone signs nobody in.',
    ].join('\n'),
  };
}

/**
 * ⚠️ **The token appears ONLY inside the link.** Quoting it separately gives it a life beyond the
 * URL: pasted into a chat it survives every place a URL would have been recognised as sensitive.
 */
export function renderInvitation(
  payload: InvitationPayload,
  ctx: RenderContext,
): RenderedMessage {
  const link = `${ctx.appBaseUrl.replace(/\/+$/, '')}/register?token=${encodeURIComponent(
    payload.inviteToken,
  )}`;
  return {
    subject: `You have been invited to ${ctx.brandName}`,
    text: [
      'Open this link to set up your account:',
      '',
      link,
      '',
      `The invitation stops working at ${formatDeadline(payload.expiresAtMs)}, and it can be used once.`,
      '',
      'You will be asked for the address this was sent to, and for a code we will email you then.',
    ].join('\n'),
  };
}

/**
 * ⭐ W36 / feature 041 — the recovery link (roadmap 3.18).
 *
 * ⚠️ **The token appears ONLY inside the link**, the same rule the invitation states one function up:
 * quoting it separately gives it a life beyond the URL, and pasted into a chat it survives every place a
 * URL would have been recognised as sensitive.
 *
 * ⚠️ **This message must not say whether an account exists**, because it is only ever sent when one does —
 * so the sentence that would leak is the one in the RESPONSE, not here. What it must avoid is the opposite
 * mistake: telling somebody who did NOT ask that their address is registered. Hence «if you did not ask
 * for this, nothing has changed» — the one line that turns an unexpected mail into information the
 * recipient can act on rather than a confirmation for whoever probed.
 *
 * ⓘ Deliberately no «click to sign in» convenience: completing this sets a password and nothing else. The
 * two-step login still runs afterwards (spec 041 FR-009), and a link that promised a session would be the
 * thing that bypasses it.
 */
export function renderRecovery(payload: RecoveryPayload, ctx: RenderContext): RenderedMessage {
  const link = `${ctx.appBaseUrl.replace(/\/+$/, '')}/recover/complete?token=${encodeURIComponent(
    payload.recoveryToken,
  )}`;
  return {
    subject: `Set a new password for ${ctx.brandName}`,
    text: [
      'Open this link to set a new password:',
      '',
      link,
      '',
      `The link stops working at ${formatDeadline(payload.expiresAtMs)}, and it can be used once.`,
      '',
      'Setting a new password signs you out everywhere, so you will be asked to sign in again — with',
      'your new password and a code we will email you then.',
      '',
      'If you did not ask for this, nothing has changed and you can ignore this message.',
    ].join('\n'),
  };
}
