import { diagnose } from './imap-reader.service';

/**
 * What a mail failure is allowed to say (Principle IV) — and what it MUST say to be worth logging.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * The rule was "log the error's name, never its message", because an IMAP or SMTP message can quote the
 * mailbox, the credentials or a header — a customer's address among them. Right rule, and it stays.
 *
 * ⚠️ But `name` on a plain `new Error(...)` is the literal string `Error`, and three different faults in
 * one afternoon of the W3 live round each logged `mailbox reader: Error`, twelve times a minute. The
 * product was telling the truth and saying nothing. *Not logged and not diagnosable are different
 * requirements, and only the first one is Principle IV's.*
 */
describe('a mail failure is diagnosable without quoting the envelope', () => {
  it('never includes the message, however tempting its contents', () => {
    const err = new Error('LOGIN failed for support-brand1@stand.test: bad password "hunter2"');
    const out = diagnose(err);
    expect(out).not.toContain('support-brand1@stand.test');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('LOGIN failed');
  });

  it('carries the syscall code, which is a fact about a socket and never about a person', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 172.19.0.9:3143'), {
      code: 'ECONNREFUSED',
    });
    expect(diagnose(err)).toContain('code=ECONNREFUSED');
    // …and still not the address the message quoted.
    expect(diagnose(err)).not.toContain('172.19.0.9');
  });

  it('names the error CLASS, so a subclass is distinguishable from a plain Error', () => {
    class ImapProtocolError extends Error {}
    expect(diagnose(new ImapProtocolError('x'))).toContain('ImapProtocolError');
  });

  /**
   * The frame is the point: `file:line` in our own source is the one piece of context that makes a
   * refusal actionable and cannot quote content. Asserted loosely — the line number moves with any edit,
   * and pinning it would make this test a maintenance tax rather than a guarantee.
   */
  it('says WHERE, in our own source', () => {
    const out = diagnose(new Error('boom'));
    expect(out).toMatch(/at=\S+\.spec\.ts:\d+:\d+/);
  });

  it('degrades honestly on a thrown non-Error', () => {
    expect(diagnose('a string')).toBe('error');
    expect(diagnose(undefined)).toBe('error');
  });
});
