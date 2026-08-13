import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

/**
 * One email → our normalised inbound message (feature 033, roadmap 6.4 — T040, research R1/R14).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * **PURE, and that is what makes the hard parts testable.** No connection, no database, no clock: a
 * `Buffer` in, a verdict out. Every case worth worrying about — a loop, a bounce, an encoded subject, a
 * reply chain, an attachment-only message — is a fixture rather than a mailbox.
 *
 * It lives in the WORKER because the worker holds the parser and the connection. `chats` receives the
 * normalised message and never sees MIME (contracts §2.2).
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── What this refuses, and why refusing matters more than parsing ────────────────────────────────
 * `mailparser` handles the decade of MIME edge cases — multipart alternatives, `=?UTF-8?B?…?=`
 * encoded words, quoted-printable, nested attachments. What it cannot do is decide whether a message is
 * a **customer** at all, and that decision is this file's real content:
 *
 *   • **A loop** (FR-033). Our own reply coming back, a vacation auto-reply, a mailing list. Without
 *     this check one auto-responder plus our own auto-reply produce a ticket each, forever, at machine
 *     speed — and every one of them looks like a real customer waiting for an answer.
 *   • **A bounce**. An empty `Return-Path` (`<>`) is the standard marker. A bounce is a delivery report,
 *     not a question, and turning it into a ticket puts a mail-server transcript in the agent's queue.
 *   • **No sender**. Nothing to answer and nobody to attribute it to.
 */

export interface NormalisedEmail {
  /** The RFC `Message-ID` — the at-most-once key (FR-032). Refused when absent. */
  messageId: string;
  inReplyTo?: string;
  /** Newest-first. ⚠️ RFC 5322 orders `References` oldest-first; this REVERSES it — see below. */
  references: string[];
  /** The envelope sender, lower-cased. Never logged (FR-047). */
  fromAddress: string;
  /** The `Subject` header verbatim, decoded. `''` means the source gave none (FR-028). */
  subject: string;
  bodyText: string;
  attachments: Array<{ filename: string; declaredContentType: string; content: Buffer }>;
  /** When the source says it was sent. Advisory only — never an ordering key we depend on. */
  sentAt?: Date;
}

/** Why a message is not a customer's message. A CLASS, and the vocabulary matches the adapter contract. */
export type EmailRefusal = 'unparseable' | 'loop' | 'no_event_id' | 'incomplete';

export type EmailParseResult =
  | { ok: true; message: NormalisedEmail }
  | { ok: false; refusal: EmailRefusal };

/**
 * `Precedence` values that mean "not addressed to a human who expects a reply".
 * De-facto rather than standard, and emitted by every mailing list and bulk sender in existence.
 */
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

/**
 * Parse and classify one raw message.
 *
 * @param raw the message source, exactly as the mailbox served it.
 * @param ourAddresses every address this deployment sends FROM, lower-cased. A message whose sender is
 *        one of ours is our own mail coming back — the loop case no header reliably marks.
 */
export async function parseInboundEmail(
  raw: Buffer,
  ourAddresses: readonly string[] = [],
): Promise<EmailParseResult> {
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(raw);
  } catch {
    // ⚠️ Nothing of the message is logged or echoed. It is a stranger's input and may carry anything —
    // including a body crafted to be read out of a log line.
    return { ok: false, refusal: 'unparseable' };
  }

  const fromAddress = firstAddress(parsed.from);
  if (!fromAddress) return { ok: false, refusal: 'incomplete' };

  if (isLoop(parsed, fromAddress, ourAddresses)) return { ok: false, refusal: 'loop' };

  // ⚠️ No `Message-ID` ⇒ no at-most-once key, so the message is REFUSED rather than given a generated
  // one. A generated key makes every redelivery look new, and an IMAP reconnect redelivers by design
  // (FR-027c) — so a generated id would turn the normal case into duplicated customer messages. Real
  // mail always has one; a message without it is machine-generated or malformed.
  const messageId = (parsed.messageId ?? '').trim();
  if (!messageId) return { ok: false, refusal: 'no_event_id' };

  const attachments = (parsed.attachments ?? [])
    // Inline images that are part of the body (a signature logo, a quoted screenshot) are not what the
    // customer attached. Kept only when the message itself presents them as attachments.
    .filter((a) => a.contentDisposition !== 'inline' || !a.related)
    .map((a) => ({
      // A filename is presentation, never a path. `mailparser` decodes encoded words for us; the
      // basename is taken so a crafted `../../etc/passwd` cannot travel further than this line.
      filename: basename(a.filename ?? 'attachment'),
      // DECLARED, and named as such: the uploads path re-derives the real type from the bytes (016).
      declaredContentType: a.contentType || 'application/octet-stream',
      content: a.content as Buffer,
    }));

  const bodyText = (parsed.text ?? '').trim();
  const subject = (parsed.subject ?? '').trim();

  // Nothing to show at all. Deliberately weaker than the API channel's "a body is required": an email
  // whose Subject is the whole question is an ordinary support request, and so is one carrying only a
  // screenshot. Refusing those would lose real customers to a rule about formatting.
  if (bodyText === '' && subject === '' && attachments.length === 0) {
    return { ok: false, refusal: 'incomplete' };
  }

  return {
    ok: true,
    message: {
      messageId,
      inReplyTo: (parsed.inReplyTo ?? '').trim() || undefined,
      references: normaliseReferences(parsed.references),
      fromAddress,
      subject,
      bodyText,
      attachments,
      sentAt: parsed.date ?? undefined,
    },
  };
}

/**
 * Is this our own mail coming back? (FR-033, research R14.)
 *
 * Five independent signals, ORed. Each one alone is enough, because a false negative here costs an
 * infinite ticket loop and a false positive costs one refused message that the sender will resend.
 */
function isLoop(
  parsed: ParsedMail,
  fromAddress: string,
  ourAddresses: readonly string[],
): boolean {
  const header = (name: string): string => {
    const v = parsed.headers?.get(name);
    return typeof v === 'string' ? v.trim().toLowerCase() : '';
  };

  // RFC 3834. Present and anything other than `no` means a machine composed it.
  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  if (BULK_PRECEDENCE.has(header('precedence'))) return true;

  // Microsoft's marker, emitted by Exchange/Outlook out-of-office replies.
  if (parsed.headers?.has('x-auto-response-suppress')) return true;

  // An empty `Return-Path` (`<>`) is the standard bounce marker.
  const returnPath = header('return-path');
  if (returnPath === '<>' || returnPath === '') {
    // ⚠️ Only ABSENT-as-empty-angle-brackets counts. A missing `Return-Path` header entirely is normal
    // on mail read straight out of a mailbox — treating that as a bounce would refuse everything.
    if (parsed.headers?.has('return-path')) return true;
  }

  // Our own address in the From. The one signal no header provides and the most likely in practice:
  // our reply arriving back through a misconfigured forward or a customer's own auto-forward rule.
  return ourAddresses.includes(fromAddress);
}

/**
 * `References` newest-first, de-duplicated.
 *
 * ⚠️ **RFC 5322 orders this header oldest-first, and the reversal here is load-bearing.** The thread
 * resolver tries candidates in order and takes the first that resolves; unreversed, a fifty-message
 * thread would resolve against its OLDEST ancestor. On a thread that was continued after a `closed`
 * ticket (FR-029b) that is the difference between joining the live conversation and joining the archived
 * one — a wrong answer that looks entirely plausible in the data.
 */
function normaliseReferences(raw: string | string[] | undefined): string[] {
  const list = typeof raw === 'string' ? raw.split(/\s+/) : Array.isArray(raw) ? raw : [];
  const cleaned = list.map((r) => r.trim()).filter((r) => r !== '');
  // ⚠️ **De-duplicate in RFC order, THEN reverse** — and the order of those two steps is a real defect
  // this test caught. Reversing first keeps the LAST occurrence of a repeated id, so a malformed chain
  // that names an old ancestor again at the end (`old mid recent old`) would promote `old` to the front
  // and the reply would resolve against the oldest message in the thread. Mailers append, so the first
  // occurrence is where an id genuinely belongs in the chain.
  return [...new Set(cleaned)].reverse();
}

/** The first usable address from a From/Sender header, lower-cased. */
function firstAddress(from: AddressObject | AddressObject[] | undefined): string {
  const objs = Array.isArray(from) ? from : from ? [from] : [];
  for (const o of objs) {
    for (const a of o.value ?? []) {
      const addr = (a.address ?? '').trim().toLowerCase();
      if (addr !== '') return addr;
    }
  }
  return '';
}

/** A filename with every directory component removed. Presentation only, never a path. */
function basename(name: string): string {
  const cut = name.split(/[\\/]/).pop() ?? '';
  return cut.trim() === '' ? 'attachment' : cut.trim();
}
