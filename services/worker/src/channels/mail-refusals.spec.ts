import { parseInboundEmail } from './email.adapter';

/**
 * T038 (feature 033, US2) — **our own mail coming back, and the one poisonous message** (FR-033/FR-034).
 * FAILS before `email.adapter.ts` exists, PASSES after.
 *
 * ⚠️ Without loop detection, one vacation auto-reply plus one of our own replies produce a ticket each,
 * forever, at machine speed — and every one of them looks like a real customer waiting for an answer.
 * Five independent signals, each sufficient on its own: a false negative costs an infinite ticket loop,
 * a false positive costs one refused message the sender will resend.
 */

const raw = (headers: string, body = 'текст обращения') =>
  Buffer.from(`${headers}\r\n\r\n${body}\r\n`, 'utf8');

const BASE = [
  'From: Player <player@mail.test>',
  'To: support@brand.test',
  'Subject: Не пришёл вывод',
  'Message-ID: <p-1@mail.test>',
].join('\r\n');

describe('a real customer message parses (the baseline the refusals are measured against)', () => {
  it('keeps the Subject, the Message-ID and the sender, lower-cased', async () => {
    const res = await parseInboundEmail(raw(BASE.replace('player@mail.test', 'Player@Mail.TEST')));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toMatchObject({
      messageId: '<p-1@mail.test>',
      subject: 'Не пришёл вывод',
      fromAddress: 'player@mail.test',
      bodyText: 'текст обращения',
    });
  });

  it('decodes an encoded-word Subject rather than storing the encoding', async () => {
    // `=?UTF-8?B?…?=` is what every non-ASCII subject arrives as. Storing it raw would put mojibake in
    // the Inbox — the exact unscannable list feature 023 exists to prevent, by a different route.
    const encoded = BASE.replace('Subject: Не пришёл вывод', 'Subject: =?UTF-8?B?0J/RgNC40LLQtdGC?=');
    const res = await parseInboundEmail(raw(encoded));
    expect(res.ok && res.message.subject).toBe('Привет');
  });

  it('reverses the References chain to newest-first, and de-duplicates it', async () => {
    // ⚠️ RFC 5322 writes this header OLDEST-first. The thread resolver takes the first candidate that
    // resolves, so unreversed a long thread would resolve against its oldest ancestor — which on a thread
    // continued after a closed ticket means joining the archive instead of the live conversation.
    const withRefs = `${BASE}\r\nReferences: <old@crm> <mid@crm> <recent@crm> <old@crm>`;
    const res = await parseInboundEmail(raw(withRefs));
    expect(res.ok && res.message.references).toEqual(['<recent@crm>', '<mid@crm>', '<old@crm>']);
  });
});

describe('our own mail coming back is refused as a loop (FR-033, research R14)', () => {
  it.each([
    ['Auto-Submitted: auto-replied', 'RFC 3834 — the standard signal'],
    ['Precedence: bulk', 'every mailing list emits it'],
    ['Precedence: list', 'a discussion list'],
    ['X-Auto-Response-Suppress: All', 'Exchange out-of-office'],
    ['Return-Path: <>', 'the standard bounce marker'],
  ])('%s → loop (%s)', async (header) => {
    const res = await parseInboundEmail(raw(`${BASE}\r\n${header}`));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal).toBe('loop');
  });

  it('`Auto-Submitted: no` is NOT a loop — the header present means nothing on its own', async () => {
    const res = await parseInboundEmail(raw(`${BASE}\r\nAuto-Submitted: no`));
    expect(res.ok).toBe(true);
  });

  /**
   * ⭐⭐ THE CONTROL THAT WAS MISSING, and its absence disabled email intake completely (live round,
   * 2026-08-05 — the first customer mail on the stand was refused `class=loop`).
   *
   * `Return-Path` is parsed by `mailparser` into an ADDRESS OBJECT, not a string. The bounce check read it
   * with a string-only helper, got `''`, saw the header PRESENT, and concluded bounce — for every message.
   * Every MTA adds this header on delivery, so in production not one email would have become a ticket.
   *
   * ⚠️ The `Return-Path: <>` case above passed throughout, and would have passed for ANY value: it asserted
   * that a refusal happened, never that the refusal discriminated. On its own it is a vacuous positive —
   * the fifth instance of that class in this product. This test is its negative control, and the two are
   * only meaningful as a pair.
   */
  it('an ORDINARY mail carrying a populated Return-Path is not a bounce (every MTA adds one)', async () => {
    const res = await parseInboundEmail(raw(`${BASE}\r\nReturn-Path: <player@mail.test>`));
    expect(res.ok).toBe(true);
  });

  it('still refuses the real bounce marker, distinguished from an address by its VALUE', async () => {
    const bounce = await parseInboundEmail(raw(`${BASE}\r\nReturn-Path: <>`));
    expect(bounce.ok).toBe(false);
    if (bounce.ok) return;
    expect(bounce.refusal).toBe('loop');
  });

  it('OUR OWN address in the From is a loop — the signal no header provides', async () => {
    // The most likely case in practice: our reply arriving back through a misconfigured forward or a
    // customer's own auto-forward rule. No header marks it, so the configured addresses do.
    const ours = raw(BASE.replace('player@mail.test', 'support@brand.test'));
    expect((await parseInboundEmail(ours, ['support@brand.test'])).ok).toBe(false);
    // …and the same message is an ordinary customer message when it is NOT one of ours.
    expect((await parseInboundEmail(ours, ['other@brand.test'])).ok).toBe(true);
  });
});

describe('what is not a customer message at all', () => {
  it('no sender → incomplete: nothing to answer and nobody to attribute it to', async () => {
    const res = await parseInboundEmail(raw('Subject: hi\r\nMessage-ID: <x@y>'));
    expect(res.ok === false && res.refusal).toBe('incomplete');
  });

  it('no Message-ID → refused, never given a generated one', async () => {
    // A generated key makes every redelivery look new, and an IMAP reconnect redelivers BY DESIGN — so a
    // generated id would turn the normal case into duplicated customer messages.
    const res = await parseInboundEmail(raw('From: p@mail.test\r\nSubject: hi'));
    expect(res.ok === false && res.refusal).toBe('no_event_id');
  });

  it('nothing at all — no body, no subject, no file → incomplete', async () => {
    const res = await parseInboundEmail(raw('From: p@mail.test\r\nMessage-ID: <e@y>', ''));
    expect(res.ok === false && res.refusal).toBe('incomplete');
  });

  it('a subject with no body IS a ticket — refusing it would lose real customers', async () => {
    const res = await parseInboundEmail(raw(BASE, ''));
    expect(res.ok).toBe(true);
    expect(res.ok && res.message.bodyText).toBe('');
  });
});

describe('an attachment travels, and its filename is never a path', () => {
  it('keeps the basename and the DECLARED type, so uploads re-derives the real one', async () => {
    const body = [
      'From: p@mail.test',
      'Message-ID: <att@y>',
      'Subject: скрин',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary=B',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'вот скрин',
      '--B',
      'Content-Type: image/png',
      'Content-Disposition: attachment; filename="../../etc/passwd"',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--B--',
      '',
    ].join('\r\n');

    const res = await parseInboundEmail(Buffer.from(body, 'utf8'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message.attachments).toHaveLength(1);
    // A filename is presentation, never a path. The traversal is cut here rather than trusted downstream.
    expect(res.message.attachments[0]!.filename).toBe('passwd');
    expect(res.message.attachments[0]!.declaredContentType).toBe('image/png');
  });
});

describe('a message that cannot be read at all does not throw (FR-034)', () => {
  it('returns a refusal instead, so the caller takes in the NEXT message', async () => {
    // Feature 031 shipped the opposite — one bad row killed the whole tick — and it was found on a live
    // run rather than by a test. A refusal is data the loop steps over; an exception is a lost batch.
    for (const junk of [Buffer.alloc(0), Buffer.from([0xff, 0xfe, 0x00, 0x01])]) {
      const res = await parseInboundEmail(junk);
      expect(res.ok).toBe(false);
    }
  });
});
