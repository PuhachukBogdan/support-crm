import { renderLoginCode, renderInvitation, type RenderContext } from './render';

/**
 * T009 (feature 028) — the two messages. FAILS before `render.ts` exists, PASSES after.
 *
 * Every assertion here corresponds to a way the message goes wrong in somebody's mailbox, not to a
 * way the function goes wrong.
 */
const CTX: RenderContext = { brandName: 'Support CRM', appBaseUrl: 'https://crm.example.test' };
const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);
const IN_TEN_MINUTES = NOW + 10 * 60_000;

describe('the login-code message', () => {
  const msg = renderLoginCode({ code: 'RFDV8T', expiresAtMs: IN_TEN_MINUTES }, CTX, NOW);

  it('puts the code where the person will see it first', () => {
    // In the subject as well as the body: it is the one thing they need, and a notification
    // preview shows the subject.
    expect(msg.subject).toContain('RFDV8T');
    expect(msg.text).toContain('RFDV8T');
  });

  it('states the deadline, in UTC and in minutes', () => {
    // ⚠️ A local time would be the SERVER's local time, which is nobody's. Both forms are given
    // because "about 10 minutes" is what a person acts on and the absolute time is what they check.
    expect(msg.text).toContain('2026-08-02 12:10 UTC');
    expect(msg.text).toMatch(/about 10 minutes/);
  });

  it('⚠️ contains NO URL at all (FR-011)', () => {
    // A clickable sign-in in a message that also carries the code turns a forwarded email into a
    // session. This is the assertion that keeps somebody from "improving" the message later.
    expect(msg.text).not.toMatch(/https?:\/\//);
    expect(msg.subject).not.toMatch(/https?:\/\//);
  });

  it('tells the recipient what to do if they did not ask for it', () => {
    expect(msg.text).toMatch(/did not start it/i);
  });

  it('uses the configured brand and nothing else', () => {
    const other = renderLoginCode(
      { code: 'RFDV8T', expiresAtMs: IN_TEN_MINUTES },
      { ...CTX, brandName: 'Acme Support' },
      NOW,
    );
    expect(other.subject).toContain('Acme Support');
    expect(other.subject).not.toContain('Support CRM');
  });
});

describe('the invitation message', () => {
  const msg = renderInvitation({ inviteToken: 'inv-1.secret', expiresAtMs: IN_TEN_MINUTES }, CTX);

  it('carries a link to the page that accepts the invitation', () => {
    expect(msg.text).toContain('https://crm.example.test/register?token=inv-1.secret');
  });

  it('⚠️ puts the token ONLY inside the link', () => {
    // Quoted separately, the token outlives the URL: pasted into a chat it is no longer recognised
    // as a credential by anything.
    const withoutTheLink = msg.text.replace(/https?:\/\/\S+/g, '');
    expect(withoutTheLink).not.toContain('inv-1.secret');
    expect(msg.subject).not.toContain('inv-1.secret');
  });

  it('url-encodes the token rather than trusting its shape', () => {
    const odd = renderInvitation({ inviteToken: 'a b&c=d', expiresAtMs: IN_TEN_MINUTES }, CTX);
    expect(odd.text).toContain('token=a%20b%26c%3Dd');
  });

  it('does not double the slash when the base URL has a trailing one', () => {
    // Somebody will configure `https://host/`. A `//register` is a different path to some proxies.
    const trailing = renderInvitation(
      { inviteToken: 't', expiresAtMs: IN_TEN_MINUTES },
      { ...CTX, appBaseUrl: 'https://crm.example.test/' },
    );
    expect(trailing.text).toContain('https://crm.example.test/register?token=t');
    expect(trailing.text).not.toContain('//register');
  });

  it('says it expires and that it works once', () => {
    expect(msg.text).toContain('2026-08-02 12:10 UTC');
    expect(msg.text).toMatch(/used once/i);
  });
});

describe('both messages, as a licensee would receive them', () => {
  it('⭐ contain no company name that did not come from configuration (FR-009, SC-008)', () => {
    // The requirement that survives the sale of this product. Our name in a licensee's staff
    // authentication mail is not a cosmetic problem.
    const rendered = [
      renderLoginCode({ code: 'ABC123', expiresAtMs: IN_TEN_MINUTES }, CTX, NOW),
      renderInvitation({ inviteToken: 't', expiresAtMs: IN_TEN_MINUTES }, CTX),
    ]
      .flatMap((m) => [m.subject, m.text])
      .join('\n');

    expect(rendered).not.toMatch(/beton|betonwin|gr8/i);
  });

  it('are plain text with no markup and no remote content (FR-007)', () => {
    const msg = renderLoginCode({ code: 'ABC123', expiresAtMs: IN_TEN_MINUTES }, CTX, NOW);
    expect(msg.text).not.toMatch(/<[a-z]/i);
    expect(msg.text).not.toMatch(/src=|background:|<img/i);
  });
});
