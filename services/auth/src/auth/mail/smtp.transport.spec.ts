import { SmtpMailTransport, classify } from './smtp.transport';
import { MailSendError } from './mail-transport';
import type { AuthConfig } from '../../config';

/**
 * T011 (feature 028) — the transport, its guard, and the rule that the relay's own words never
 * travel. FAILS before `smtp.transport.ts` exists, PASSES after.
 */
function cfg(over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    MAIL_HOST: 'mailpit',
    MAIL_PORT: 1025,
    MAIL_SECURE: false,
    MAIL_FROM: 'no-reply@example.test',
    MAIL_ALLOWED_RECIPIENT_DOMAINS: '',
    ...over,
  } as unknown as AuthConfig;
}

const MESSAGE = { to: 'agent@example.test', subject: 's', text: 't' };

describe('SmtpMailTransport — the recipient guard', () => {
  it('⭐ refuses a recipient outside the list WITHOUT opening a connection', async () => {
    // The harm is the connection: a synthetic stand that reaches a real mailbox has already done
    // the damage by the time the send succeeds.
    const sendMail = jest.fn();
    const transport = new SmtpMailTransport(
      cfg({ MAIL_ALLOWED_RECIPIENT_DOMAINS: 'example.test' }),
      sendMail,
    );

    await expect(transport.send({ ...MESSAGE, to: 'stranger@elsewhere.test' })).rejects.toThrow(
      MailSendError,
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('allows a recipient inside the list', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const transport = new SmtpMailTransport(
      cfg({ MAIL_ALLOWED_RECIPIENT_DOMAINS: 'example.test, other.test' }),
      sendMail,
    );

    await transport.send(MESSAGE);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('an empty list is unrestricted, not a blanket refusal', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    await new SmtpMailTransport(cfg(), sendMail).send({ ...MESSAGE, to: 'anyone@anywhere.test' });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('compares the domain case-insensitively', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const transport = new SmtpMailTransport(
      cfg({ MAIL_ALLOWED_RECIPIENT_DOMAINS: 'Example.TEST' }),
      sendMail,
    );
    await transport.send({ ...MESSAGE, to: 'Agent@EXAMPLE.test' });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('reports the refusal as its own class, distinct from a relay problem', async () => {
    const transport = new SmtpMailTransport(
      cfg({ MAIL_ALLOWED_RECIPIENT_DOMAINS: 'example.test' }),
      jest.fn(),
    );
    await expect(
      transport.send({ ...MESSAGE, to: 'stranger@elsewhere.test' }),
    ).rejects.toMatchObject({ errorClass: 'recipient_blocked' });
  });
});

describe('SmtpMailTransport — what it sends', () => {
  it('sends from the configured address, with the text as given', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    await new SmtpMailTransport(cfg(), sendMail).send({
      to: 'agent@example.test',
      subject: 'Sign-in code: ABC123',
      text: 'ABC123',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'no-reply@example.test',
      to: 'agent@example.test',
      subject: 'Sign-in code: ABC123',
      text: 'ABC123',
    });
  });
});

describe('SmtpMailTransport — failures become CLASSES', () => {
  it('⚠️ the relay’s own message does not survive the boundary', async () => {
    // A real rejection: `550 5.1.1 <agent@example.test> recipient rejected`. It quotes the
    // envelope. If it reached a record or a log, the recipient would travel with it — and on the
    // verify path the body would too.
    const relaySaid = Object.assign(
      new Error('550 5.1.1 <agent@example.test> recipient rejected — code ABC123 not delivered'),
      { responseCode: 550 },
    );
    const transport = new SmtpMailTransport(cfg(), jest.fn().mockRejectedValue(relaySaid));

    const err = await transport.send(MESSAGE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MailSendError);
    expect((err as MailSendError).errorClass).toBe('refused');
    // The whole point: nothing of the original text remains anywhere on the thrown value.
    expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack })).not.toContain(
      'ABC123',
    );
    expect((err as Error).message).not.toContain('agent@example.test');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it.each([
    ['ECONNREFUSED', 'unreachable'],
    ['ETIMEDOUT', 'unreachable'],
    ['ENOTFOUND', 'unreachable'],
    ['ESOCKET', 'unreachable'],
    ['EAUTH', 'auth_failed'],
  ])('classifies %s as %s', (code, expected) => {
    expect(classify(Object.assign(new Error('x'), { code }))).toBe(expected);
  });

  it('classifies a 5xx response as refused, and a 4xx as retryable', () => {
    expect(classify(Object.assign(new Error('x'), { responseCode: 550 }))).toBe('refused');
    expect(classify(Object.assign(new Error('x'), { responseCode: 421 }))).toBe('unreachable');
  });

  it('⚠️ treats an UNRECOGNISED failure as retryable', () => {
    // Giving up on a fault we do not understand loses a login code. The attempt ceiling is what
    // stops this from looping for ever — not pessimism about unknown errors.
    expect(classify(new Error('something new'))).toBe('unreachable');
    expect(classify(undefined)).toBe('unreachable');
  });
});
