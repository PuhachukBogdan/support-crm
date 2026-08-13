import { createSmtpSender } from './smtp.sender';
import { isHostAllowed, parseHostAllowList } from './guards';
import { MailSendError } from './mail-transport';

/**
 * T009 (feature 033) — what the move ADDED to the shared transport.
 * FAILS before the host guard and the three optional message fields exist, PASSES after.
 *
 * ── Deliberately NOT re-tested here ─────────────────────────────────────────────────────────────
 * The recipient guard, the error classification table and the "relay's words do not survive" rule.
 * Feature 028's `smtp.transport.spec.ts` covers all three and passes **unmodified** against this
 * implementation — which is the actual proof that the move changed nothing. Copying those assertions
 * here would double the test lines for one fact and give the block's test budget nothing back.
 */
const CFG = {
  host: 'greenmail',
  port: 3025,
  secure: false,
  from: 'support@stand.test',
  allowedRecipientDomains: [] as string[],
  allowedHosts: [] as string[],
};

const MESSAGE = { to: 'player@example.test', subject: 's', text: 't' };

describe('the host allow-list (FR-041/FR-048)', () => {
  it('⭐ refuses a host outside the list WITHOUT opening a connection', async () => {
    // The harm is the connection. A stand pointed at a real relay has already reached real people by
    // the time the send succeeds, so a check that runs after connecting proves nothing.
    const sendMail = jest.fn();
    const sender = createSmtpSender({ ...CFG, allowedHosts: ['mailpit'] }, sendMail);

    await expect(sender.send(MESSAGE)).rejects.toThrow(MailSendError);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports a blocked host as its OWN class, not as a blocked recipient', async () => {
    // Collapsing the two would make a misconfigured relay look like a refused customer, and whoever
    // read the log would go looking at the customer.
    const sender = createSmtpSender({ ...CFG, allowedHosts: ['mailpit'] }, jest.fn());
    await expect(sender.send(MESSAGE)).rejects.toMatchObject({ errorClass: 'host_blocked' });
  });

  it('checks the host BEFORE the recipient', async () => {
    // Both would refuse this message. The host is the bigger fact and must be the reported one.
    const sender = createSmtpSender(
      { ...CFG, allowedHosts: ['mailpit'], allowedRecipientDomains: ['nowhere.test'] },
      jest.fn(),
    );
    await expect(sender.send(MESSAGE)).rejects.toMatchObject({ errorClass: 'host_blocked' });
  });

  it('an empty list is unrestricted — the reading that keeps production sending', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    await createSmtpSender(CFG, sendMail).send(MESSAGE);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('matches a configured host written with its port', () => {
    // An operator copies `greenmail:3143` out of compose.yaml. If that failed to match, mail would stop
    // for a reason invisible from the value they typed — and the natural fix is to empty the list,
    // which turns the guard off entirely.
    expect(isHostAllowed('greenmail', parseHostAllowList('GreenMail:3143'))).toBe(true);
  });
});

describe('the three fields feature 033 added to a message', () => {
  it('threads: headers reach the transport verbatim', async () => {
    // Without `Message-ID` on the way out there is nothing for a customer's reply to quote, and
    // threading cannot be reconstructed after the fact — the whole reason inbound and outbound email
    // had to be one feature.
    const sendMail = jest.fn().mockResolvedValue({});
    await createSmtpSender(CFG, sendMail).send({
      ...MESSAGE,
      headers: { 'Message-ID': '<a@crm>', 'In-Reply-To': '<b@player>' },
    });
    expect(sendMail.mock.calls[0][0].headers).toEqual({
      'Message-ID': '<a@crm>',
      'In-Reply-To': '<b@player>',
    });
  });

  it("a message's own `from` overrides the transport default, for a per-brand address", async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    await createSmtpSender(CFG, sendMail).send({ ...MESSAGE, from: 'brand2@stand.test' });
    expect(sendMail.mock.calls[0][0].from).toBe('brand2@stand.test');
  });

  it('falls back to the configured sender when a message names none', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    await createSmtpSender(CFG, sendMail).send(MESSAGE);
    expect(sendMail.mock.calls[0][0].from).toBe('support@stand.test');
  });

  it('omits `headers` and `attachments` entirely when absent', async () => {
    // Auth sends no headers and no files. Passing `undefined` keys instead of omitting them is how a
    // library ends up emitting an empty header block — and this is what keeps 028 byte-identical.
    const sendMail = jest.fn().mockResolvedValue({});
    await createSmtpSender(CFG, sendMail).send(MESSAGE);
    expect(Object.keys(sendMail.mock.calls[0][0])).toEqual(['from', 'to', 'subject', 'text']);
  });

  it('carries attachments through', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    await createSmtpSender(CFG, sendMail).send({
      ...MESSAGE,
      attachments: [{ filename: 'r.pdf', contentType: 'application/pdf', content: Buffer.from('x') }],
    });
    expect(sendMail.mock.calls[0][0].attachments).toHaveLength(1);
  });
});
