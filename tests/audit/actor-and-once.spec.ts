import { buildEntry, AuditEntryError } from '@crm/common';

/**
 * T041 + T043 (feature 015, US2) — who an entry names, and how many entries an action leaves.
 *
 * **Attribution (SC-009).** Under owner view-as, the previewed ROLE is not the actor. Nobody performed
 * anything as a role; a real person did, while looking through one. Recording the role would put a fiction in
 * the one record whose purpose is accountability — and it is the highest-privileged user who has the preview
 * feature, so that fiction would cover exactly the acts most worth attributing.
 *
 * **Exactly once (SC-005).** There is deliberately no deduplication key. Feature 014 needed one because a
 * scheduler could redeliver an event; nothing redelivers a human action. A retried grant is a NEW act and
 * deserves its own entry — "two attempts, one failed" is precisely what a reviewer needs to see, and a dedup
 * key would erase it. So the guarantee is a property of the transaction, and this spec pins the reasoning
 * down so a future "fix" for the apparent duplicate has to argue with it.
 */
describe('an entry names the REAL actor', () => {
  it('records the acting user, not the previewed role', () => {
    const entry = buildEntry({
      action: 'permission.grant',
      actorUserId: 'god',
      targetRef: 'u-1',
      underPreview: true,
      detail: { scope: 'user', permissionKey: 'crm.inbox.view', grant: true },
    });
    expect(entry.actor_user_id).toBe('god');
    expect(entry.under_preview).toBe(true);
    // There is no field a role could be written into — the shape itself refuses the fiction.
    expect(Object.keys(entry)).not.toContain('previewed_role');
  });

  it('defaults to not-previewing rather than guessing', () => {
    const entry = buildEntry({ action: 'audit.read', actorUserId: 'god', targetRef: 'acc-1' });
    expect(entry.under_preview).toBe(false);
    expect(entry.actor_kind).toBe('user');
  });

  it('refuses a human entry with no actor', () => {
    expect(() =>
      buildEntry({ action: 'permission.grant', actorUserId: '', targetRef: 'u-1' }),
    ).toThrow(AuditEntryError);
    expect(() =>
      buildEntry({ action: 'permission.grant', actorUserId: '   ', targetRef: 'u-1' }),
    ).toThrow(AuditEntryError);
  });

  it('refuses an entry with no target', () => {
    expect(() => buildEntry({ action: 'permission.grant', actorUserId: 'god', targetRef: '' })).toThrow(
      AuditEntryError,
    );
  });
});

describe('a caller-less action names the rule, never "the system"', () => {
  it('accepts a system actor that says which rule acted, under whose authority', () => {
    const entry = buildEntry({
      action: 'automation.delete',
      actorUserId: '',
      actorKind: 'system',
      actorRef: 'rule:seed-auto-1 author:seed-user-1',
      targetRef: 'a-1',
    });
    expect(entry.actor_kind).toBe('system');
    expect(entry.actor_ref).toContain('rule:');
  });

  // "The system did it" is not an accountable answer. Feature 014's engine acts with its author's authority,
  // so an entry must be able to say whose.
  it('refuses a system actor with no reference', () => {
    expect(() =>
      buildEntry({
        action: 'automation.delete',
        actorUserId: '',
        actorKind: 'system',
        targetRef: 'a-1',
      }),
    ).toThrow(AuditEntryError);
  });
});

describe('exactly one entry per action actually performed', () => {
  // The same action performed twice yields two DISTINCT entries. Asserted here as the intended behaviour so
  // that "we are getting duplicates" is answered by this comment rather than by adding a dedup key.
  it('two attempts at the same change produce two entries — deliberately', () => {
    const input = {
      action: 'permission.grant' as const,
      actorUserId: 'god',
      targetRef: 'u-1',
      detail: { scope: 'user', permissionKey: 'crm.inbox.view', grant: true },
    };
    const first = buildEntry(input);
    const second = buildEntry(input);
    // Identical content — and that is fine. What makes them one-per-action is the transaction they sit in,
    // not a uniqueness key: a rolled-back action leaves none, a committed one leaves exactly one.
    expect(second).toEqual(first);
  });

  it('the shape carries no idempotency key to key a dedup on', () => {
    const entry = buildEntry({ action: 'audit.read', actorUserId: 'god', targetRef: 'acc-1' });
    for (const absent of ['event_key', 'idempotency_key', 'request_id', 'dedup_key']) {
      expect(Object.keys(entry)).not.toContain(absent);
    }
  });
});
