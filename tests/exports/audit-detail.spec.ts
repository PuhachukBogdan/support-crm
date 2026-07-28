import { DETAIL_KEYS, parseDetail, AuditDetailError } from '../../libs/common/src/audit/detail';
import { AUDIT_ACTIONS } from '../../libs/common/src/audit/catalogue';

/**
 * T035 (feature 017, US2) — **the export class cannot express PII** (FR-019 / SEC-26).
 *
 * Feature 015 built the allow-list; this file is the export writer's own proof that the list is the
 * right one for THIS payload. The distinction the tests below insist on is between *rejected* and
 * *sanitized*, and it is the whole point: a sanitizer is a place where the next developer adds a
 * "helpful" field and a redaction that mostly works. A refusal is a build break.
 *
 * Why it matters more here than anywhere else in the product: these rows describe **who extracted
 * customer data in bulk**. A leak in this detail would file the protected values next to the record of
 * who wanted them — the audit trail becoming the largest single PII disclosure in the system.
 */
const ACTION = 'export.create';

describe('the export class allows exactly three keys', () => {
  it('format / rowCount / scope — pinned literally', () => {
    // Pinned rather than derived: a future edit that widens this list should have to change a test that
    // says why, not merely stay green.
    expect([...DETAIL_KEYS.export].sort()).toEqual(['format', 'rowCount', 'scope']);
  });

  it('a valid detail passes through unchanged', () => {
    expect(parseDetail(ACTION, { format: 'csv', rowCount: 137, scope: 'conversations' })).toEqual({
      format: 'csv',
      rowCount: 137,
      scope: 'conversations',
    });
  });

  it('the action is live and written by chats (feature 017 corrected the writer)', () => {
    expect(AUDIT_ACTIONS[ACTION].status).toBe('live');
    expect(AUDIT_ACTIONS[ACTION].writer).toBe('chats');
    expect(AUDIT_ACTIONS[ACTION].class).toBe('export');
  });
});

describe('*** everything an export could leak is REJECTED, not stripped ***', () => {
  const refused: Array<[string, unknown]> = [
    // A filter value is the request restated: "which player" IS a player id.
    ['a filter value', { format: 'csv', rowCount: 1, playerId: 'ply-4711' }],
    ['a filter map', { format: 'csv', rowCount: 1, filters: ['playerId'] }],
    ['a filename', { format: 'csv', rowCount: 1, filename: 'conversations-2026-07-28.csv' }],
    ['a contact value', { format: 'csv', rowCount: 1, email: 'a.player@example.com' }],
    ['a message body', { format: 'csv', rowCount: 1, body: 'my card is 4111 1111 1111 1111' }],
    ['a subject line', { format: 'csv', rowCount: 1, subject: 'withdrawal problem' }],
    ['a row sample', { format: 'csv', rowCount: 1, firstRow: 'conv-1,open,high' }],
    // Legitimate keys — for OTHER classes. `filters` belongs to `access`, `name` to `deletion`.
    // Class-scoping is what stops the union of all allow-lists becoming the effective allow-list.
    ['another class’s key', { format: 'csv', rowCount: 1, name: 'VIP escalation' }],
    ['a permission key from the privilege class', { format: 'csv', roleKey: 'vip_support' }],
  ];

  it.each(refused)('%s is refused', (_label, detail) => {
    expect(() => parseDetail(ACTION, detail)).toThrow(AuditDetailError);
  });

  it('the refusal names the KEY and the allow-list, never the value', () => {
    // An error message is a log line waiting to happen. If it echoed the value, the guard would BE the
    // leak — and on the path where somebody is already doing something wrong.
    let message = '';
    try {
      parseDetail(ACTION, { format: 'csv', email: 'a.player@example.com' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('email');
    expect(message).toContain('format');
    expect(message).not.toContain('a.player@example.com');
    expect(message).not.toContain('example.com');
  });
});

describe('*** PII smuggled INTO an allowed key is refused too ***', () => {
  // The key list stops `email` being added as a field. This stops a player's email arriving as the
  // value of `scope` — which is the failure mode a key-only allow-list has.
  it.each([
    ['an email in scope', { scope: 'a.player@example.com' }],
    ['a phone in format', { format: '+34 600 123 456' }],
    ['a card number in scope', { scope: 'card 4111 1111 1111 1111 on file' }],
    ['prose in scope', { scope: 'x'.repeat(200) }],
  ])('%s is refused', (_label, detail) => {
    expect(() => parseDetail(ACTION, { format: 'csv', rowCount: 1, ...detail })).toThrow(
      AuditDetailError,
    );
  });

  it('a nested object is refused — a detail is flat by contract', () => {
    // Nesting is how a whole request object gets attached "just for debugging".
    expect(() =>
      parseDetail(ACTION, { format: 'csv', rowCount: 1, scope: { name: 'conversations' } }),
    ).toThrow(AuditDetailError);
  });

  it('our own identifiers still pass — a guard that refuses valid writes gets relaxed', () => {
    // The counter-case, recorded in 015's detail module: a naive card detector rejected
    // `seed-user-0000-0000-000000000001`. A false positive here is not a harmless extra safety
    // margin — it is the reason someone loosens the check.
    expect(parseDetail(ACTION, { format: 'csv', rowCount: 0, scope: 'conversations' })).toEqual({
      format: 'csv',
      rowCount: 0,
      scope: 'conversations',
    });
  });
});
