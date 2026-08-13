import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * T024 + T059's structural half (feature 033) — **the three constraints, read off the SCHEMA.**
 *
 * ── Why this exists beside `migration-033.spec.ts` ───────────────────────────────────────────────
 * That file reads the MIGRATION: proof the constraint will be created. This one reads the Prisma
 * SCHEMA: proof the model still declares it. The two drift apart in exactly one way, and it is the
 * dangerous way — somebody edits the model, Prisma generates a new migration that DROPS an index, and
 * the old migration file still contains the `CREATE UNIQUE INDEX` that made the first test pass.
 *
 * A single test over either artefact alone would survive that. Both together do not.
 */
const ROOT = resolve(__dirname, '..', '..');
const CHATS = readFileSync(join(ROOT, 'services', 'chats', 'prisma', 'schema.prisma'), 'utf8');
const USERS = readFileSync(join(ROOT, 'services', 'users', 'prisma', 'schema.prisma'), 'utf8');

/**
 * The body of one model block, so an assertion cannot match a neighbour's attribute.
 *
 * ⚠️ **Prisma doc comments (`///`) are stripped**, and that is not a convenience. Two assertions below are
 * NEGATIVE — "this model declares no secret column", "no chats model holds a contact value" — and the
 * models EXPLAIN AT LENGTH why those things are absent. A scan over the prose is satisfied by deleting the
 * explanation, which is the trade `no-status-key-branch.spec.ts` refuses. It caught this file on its first
 * run, exactly as it had caught `migration-033.spec.ts` an hour earlier — the same mistake twice, which is
 * why the stripping is now written down rather than remembered.
 */
function modelBody(schema: string, name: string): string {
  const m = new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!m) throw new Error(`model ${name} not found — the scan would otherwise pass vacuously`);
  return m[1]!.replace(/^\s*\/\/.*$/gm, '');
}

describe('the scan found the models (nothing below can pass vacuously)', () => {
  it.each(['Channel', 'ChannelIntake', 'OutboundMessage', 'Conversation', 'Message'])(
    'chats declares `%s`',
    (name) => {
      expect(modelBody(CHATS, name).length).toBeGreaterThan(50);
    },
  );

  it('users declares `ChannelParticipant`', () => {
    expect(modelBody(USERS, 'ChannelParticipant').length).toBeGreaterThan(50);
  });
});

describe('*** at-most-once intake (FR-012/FR-013) ***', () => {
  it('ChannelIntake is unique on (channel_id, external_event_id)', () => {
    // The write path INSERTS FIRST and reads P2002 as "already accepted". Without this, the provider's
    // retry — which arrives concurrently by design — creates a second ticket nobody can tell apart.
    expect(modelBody(CHATS, 'ChannelIntake')).toMatch(
      /@@unique\(\[channel_id, external_event_id\]\)/,
    );
  });
});

describe('*** one copy per inbound email (FR-032) ***', () => {
  it('Message is unique on (account_id, external_id)', () => {
    expect(modelBody(CHATS, 'Message')).toMatch(/@@unique\(\[account_id, external_id\]\)/);
  });

  it('⚠️ and `external_id` is NULLABLE, which the unique depends on', () => {
    // Postgres treats NULLs as DISTINCT in a unique index. Every non-email message has NULL and they must
    // not collide with each other. If this column ever became NOT NULL, or the index gained
    // `NULLS NOT DISTINCT`, "one copy per inbound email" would quietly become "one message per account".
    expect(modelBody(CHATS, 'Message')).toMatch(/external_id\s+String\?/);
  });
});

describe('*** one delivery per reply (FR-036/FR-038) ***', () => {
  it('OutboundMessage is unique on (message_id)', () => {
    // This is what makes "exactly one" a property of the database rather than of the caller's care: a
    // retried request that posts the same reply cannot produce a second copy for the customer.
    expect(modelBody(CHATS, 'OutboundMessage')).toMatch(/@@unique\(\[message_id\]\)/);
  });

  it('the claim predicate is indexed in its exact shape', () => {
    expect(modelBody(CHATS, 'OutboundMessage')).toMatch(/@@index\(\[status, next_attempt_at\]\)/);
  });

  it('⚠️ carries NO recipient column — the envelope is fetched at send time', () => {
    // 028 stores and logs the recipient, correctly, because that address is an operator's own. Here it is
    // a CUSTOMER's, which is what anti-pitching protects, so it is never stored beside the queue row.
    const body = modelBody(CHATS, 'OutboundMessage');
    expect(body).not.toMatch(/to_email|recipient|address|reply_to/i);
  });
});

describe('*** the envelope lives in users, and chats holds a handle (FR-021b) ***', () => {
  it('users holds the address; chats holds an opaque participant id', () => {
    expect(modelBody(USERS, 'ChannelParticipant')).toMatch(/address\s+String\b/);
    expect(modelBody(CHATS, 'Conversation')).toMatch(/channel_participant_id\s+String\?/);
  });

  it('⭐ NO chats model holds a contact value', () => {
    // The load-bearing negative of this whole feature. `ContactMatch`'s own comment names what a column
    // here would create: a PII surface the tier policy does not classify, masking does not cover, exports
    // do not know about, and a log could reach.
    for (const model of ['Conversation', 'Message', 'Channel', 'ChannelIntake', 'OutboundMessage']) {
      const body = modelBody(CHATS, model);
      expect(body).not.toMatch(/^\s*(email|phone|to_email|from_email|msisdn|recipient)\s/m);
    }
  });

  it('a returning customer reuses one participant row per brand', () => {
    expect(modelBody(USERS, 'ChannelParticipant')).toMatch(
      /@@unique\(\[account_id, brand_id, kind, address\]\)/,
    );
  });
});

describe('*** the channel row holds no secret (research R11) ***', () => {
  it('Channel declares no secret, token or hash column', () => {
    // Verifying an HMAC needs the key material, so unlike feature 028's invite token this cannot be a
    // hash — and a recoverable secret at rest needs encryption and key management no MVP channel earns.
    // It lives in `CHANNEL_SECRETS`. This asserts the row never grows a place to put one.
    const body = modelBody(CHATS, 'Channel');
    expect(body).not.toMatch(/secret|token|password|hash/i);
  });

  it('and is unique per (account, key) so a delivery names exactly one channel', () => {
    expect(modelBody(CHATS, 'Channel')).toMatch(/@@unique\(\[account_id, key\]\)/);
  });
});
