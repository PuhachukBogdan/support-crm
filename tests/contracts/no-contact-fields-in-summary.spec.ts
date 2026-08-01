import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from '@crm/common';

const ROOT = resolve(__dirname, '..', '..');
const CHATS_PROTO = join(ROOT, 'libs', 'proto', 'crm', 'chats', 'v1', 'chats.proto');

/**
 * Feature 022 (roadmap 4.13), T062 — **the card's contact summary cannot carry a contact value.**
 *
 * ── Why a test and not a decision ───────────────────────────────────────────────────────────────
 * FR-016 requires the guarantee be *structural and asserted*: "the payload has no field able to carry
 * one … asserted by test, not by convention". Anti-pitching (ADR 0032 §5 / SEC-AP1) is an insider-risk
 * control — phone, email, address and messenger handles flow to telephony and mailings and are never
 * shown to the agent — and the whole point of encoding it as a policy-layer invariant rather than a UI
 * rule is that it must survive the next refactor. A decision with no test does not.
 *
 * ── What it protects specifically ───────────────────────────────────────────────────────────────
 * `ContactSummary` is a NEW message that describes a customer, and it is the natural place for somebody
 * to later add "and their email, since we're already here". This guard makes that a failing test.
 *
 * ── The distinction it encodes ──────────────────────────────────────────────────────────────────
 * A channel **kind** (`email`, `whatsapp`) is not a contact value, and the card is useless without it.
 * A channel **identifier** (the address, the number, the handle) is one. So `channel` is fine and
 * `channel_address` would not be — which is exactly the difference the pattern below is written to catch.
 */

/** Extract a proto message body by name (comments stripped first, so an example in a note is inert). */
function messageBody(proto: string, name: string): string | null {
  const code = stripComments(proto);
  const m = new RegExp(String.raw`message\s+${name}\s*\{([\s\S]*?)\n\}`).exec(code);
  return m ? m[1]! : null;
}

/** Field names declared in a proto message body. */
function fieldNames(body: string): string[] {
  return [...body.matchAll(/^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => m[1]!);
}

/**
 * The contact-value family. Deliberately matched as SUBSTRINGS of a field name: `player_email`,
 * `contact_phone` and `msisdn` must all be caught, and a rule that only matched exact names would be
 * defeated by any prefix.
 *
 * `channel` is absent from this list ON PURPOSE (see the header). `address` catches `email_address` too.
 */
const CONTACT_TOKENS = [
  'phone',
  'email',
  'msisdn',
  'address',
  'handle',
  'telegram',
  'whatsapp_id',
  'username',
  'contact',
  'surname',
  'last_name',
  'birth',
];

/** The messages this feature added to describe a customer. */
const GUARDED = ['ContactSummary', 'ChannelContactEntry', 'StatusCount'];

/**
 * ⚠️ **Timestamps are excluded, and the guard's own first run is why.**
 *
 * `CONTACT_TOKENS` contains `contact` so that `contact_phone` / `contact_value` are caught whatever they
 * are prefixed with. That immediately flagged this feature's own `last_contact_at` — a Date, not a way to
 * reach anybody. Widening the token list to exact names would have been the wrong repair: `player_email`
 * must stay caught.
 *
 * So a field whose name ends in `_at` is an instant by this repository's naming convention across every
 * proto, and an instant cannot carry an address. The backstop for the guarded messages is the exact
 * field-list assertion below (`toEqual`), so this exemption cannot be used to smuggle anything in: a new
 * field of any name fails there first.
 */
export function contactTokensIn(body: string): string[] {
  return fieldNames(body)
    .filter((f) => !/_at$/.test(f))
    .filter((f) => CONTACT_TOKENS.some((t) => f.toLowerCase().includes(t)));
}

describe('T062 — the contact summary declares no field able to carry a contact value', () => {
  const proto = readFileSync(CHATS_PROTO, 'utf8');

  it('every guarded message was actually FOUND (a scan that matched nothing must fail)', () => {
    // The 2026-07-29 lesson, twice over: a `git grep` that could not run was read as "no matches", and a
    // reach assertion is the only thing that notices. If a message is renamed, this fails instead of the
    // guard quietly protecting nothing.
    for (const name of GUARDED) {
      expect({ name, found: messageBody(proto, name) !== null }).toEqual({ name, found: true });
    }
  });

  it('no guarded message declares a contact-value field', () => {
    const offenders: string[] = [];
    for (const name of GUARDED) {
      for (const field of contactTokensIn(messageBody(proto, name)!)) {
        offenders.push(`${name}.${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the summary carries exactly the fields the card needs, and nothing shaped like a person', () => {
    // Pinned as a list, so ADDING a field is a visible act rather than a diff nobody reads. That is the
    // same discipline `tier-agreement.spec.ts` applies to the `Player` message.
    expect(fieldNames(messageBody(proto, 'ContactSummary')!)).toEqual([
      'last_inbound_at',
      'last_outbound_at',
      'last_contact_at',
      'conversation_count',
      'counts_by_status',
      'channels',
    ]);
    expect(fieldNames(messageBody(proto, 'ChannelContactEntry')!)).toEqual([
      'channel',
      'channel_unrecorded',
      'last_inbound_at',
      'last_outbound_at',
      'conversation_count',
    ]);
  });

  it('the channel is a KIND and a FLAG — never an identifier', () => {
    const body = messageBody(proto, 'ChannelContactEntry')!;
    expect(body).toMatch(/string channel = 1/);
    expect(body).toMatch(/bool channel_unrecorded = 2/);
    // A future `channel_address` / `channel_handle` is what this guard exists to stop, and the assertion
    // above (`toEqual` on the field list) is what would catch it. Restated here as intent.
    expect(fieldNames(body).filter((f) => f.startsWith('channel'))).toEqual([
      'channel',
      'channel_unrecorded',
    ]);
  });
});

describe('T062 — the detector can fail (proved on planted input)', () => {
  const planted = (fields: string) => `message X {\n${fields}\n}`;

  it('flags each contact-value shape', () => {
    for (const field of [
      'string phone = 1;',
      'string player_email = 2;',
      'string email_address = 3;',
      'string msisdn = 4;',
      'string telegram_handle = 5;',
      'string contact_value = 6;',
      'string surname = 7;',
      'string birth_date = 8;',
    ]) {
      const body = messageBody(planted(`  ${field}`), 'X')!;
      expect({ field, flagged: contactTokensIn(body).length > 0 }).toEqual({ field, flagged: true });
    }
  });

  it('does not flag a TIMESTAMP whose name contains a token — the guard’s own first failure', () => {
    // `last_contact_at` tripped this guard on its first run. Recorded as a case rather than as a silent
    // widening of the rule, because the next person to add a token needs to know the exemption exists.
    const body = messageBody(planted('  string last_contact_at = 1;'), 'X')!;
    expect(contactTokensIn(body)).toEqual([]);
    // …while a real contact value with the same prefix is still caught.
    const bad = messageBody(planted('  string last_contact_phone = 1;'), 'X')!;
    expect(contactTokensIn(bad)).toEqual(['last_contact_phone']);
  });

  it('does NOT flag the fields this feature legitimately has', () => {
    const body = messageBody(
      planted(
        [
          '  string channel = 1;',
          '  bool channel_unrecorded = 2;',
          '  string last_inbound_at = 3;',
          '  int32 conversation_count = 4;',
          '  repeated StatusCount counts_by_status = 5;',
        ].join('\n'),
      ),
      'X',
    )!;
    expect(contactTokensIn(body)).toEqual([]);
  });

  it('ignores a contact field named only in a COMMENT — the case that breaks a token grep', () => {
    // This file's own header and the proto's own comments both contain the word "email" while explaining
    // the rule. Three guards written on 2026-07-29 each failed on their own explanatory note first, which
    // is why comments are stripped before matching.
    const body = messageBody(
      `message X {\n  // string email = 9; would be forbidden here\n  string channel = 1;\n}`,
      'X',
    )!;
    expect(contactTokensIn(body)).toEqual([]);
  });

  it('is not fooled by a `//` inside a string default or option', () => {
    const body = messageBody(
      `message X {\n  string channel = 1 [(x) = "https://a//b"];\n  string phone = 2;\n}`,
      'X',
    )!;
    expect(contactTokensIn(body)).toContain('phone');
  });
});
