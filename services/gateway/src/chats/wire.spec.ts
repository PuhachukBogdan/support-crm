import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  toKindWire,
  toMacroActionsWire,
  toMacroActionTypeWire,
  toProjectionWire,
  toStatusKey,
  toStatusCategoryWire,
  toSubjectWire,
  MAX_SUBJECT_LENGTH,
} from './wire';

/**
 * Regression specs for the two defects feature-012 **Track B** found live (2026-07-26). Both were
 * invisible to Track A because every spec passed canonical values; only a real client sending a
 * plausible-but-wrong value exposed them.
 */
describe('chats REST → wire mapping (fail-closed)', () => {
  describe('kind — the SEC-13 one', () => {
    it('maps the two documented kinds', () => {
      expect(toKindWire('reply')).toBe('MESSAGE_KIND_PUBLIC_REPLY');
      expect(toKindWire('note')).toBe('MESSAGE_KIND_PRIVATE_NOTE');
    });

    it('defaults to a public reply only when the kind is absent', () => {
      expect(toKindWire()).toBe('MESSAGE_KIND_PUBLIC_REPLY');
      expect(toKindWire('')).toBe('MESSAGE_KIND_PUBLIC_REPLY');
    });

    // THE bug: `private_note` silently became a PUBLIC reply, publishing an intended internal note
    // to the customer. An unrecognized kind must fail, never resolve to customer-visible.
    it.each(['private_note', 'PRIVATE_NOTE', 'internal', 'Note', 'privatenote', 'repl'])(
      'rejects the unrecognized kind %p instead of publishing it to the customer',
      (kind) => {
        expect(() => toKindWire(kind)).toThrow(BadRequestException);
        // and specifically never yields the customer-visible enum
        try {
          toKindWire(kind);
        } catch (e) {
          expect((e as BadRequestException).message).not.toContain('MESSAGE_KIND_PUBLIC_REPLY');
        }
      },
    );
  });

  describe('projection', () => {
    it('maps documented projections; absent → staff', () => {
      expect(toProjectionWire('staff')).toBe('THREAD_PROJECTION_STAFF');
      expect(toProjectionWire('customer')).toBe('THREAD_PROJECTION_CUSTOMER');
      expect(toProjectionWire()).toBe('THREAD_PROJECTION_STAFF');
    });

    it.each(['CUSTOMER', 'client', 'cust', 'public'])('rejects unknown projection %p', (p) => {
      expect(() => toProjectionWire(p)).toThrow(BadRequestException);
    });
  });

  /**
   * ⭐ Feature 032 (roadmap 4.16) — the status VOCABULARY left this tier; the CATEGORY vocabulary did not.
   *
   * The four-value map that used to be asserted here was the right shape for an enum and the wrong shape
   * for configuration: a copy at the gateway would go stale the moment a supervisor added a status, which
   * is feature 017's `pending`/`running` drift one layer up.
   */
  describe('status key (feature 032)', () => {
    it('passes a key through, trimmed — a supervisor may invent one and the gateway must not know', () => {
      expect(toStatusKey('vip_pending')).toBe('vip_pending');
      expect(toStatusKey('  supervisor_review  ')).toBe('supervisor_review');
      // ⚠️ Including a key this deployment has not configured: refusing it is `chats`'s job, against the
      // CALLER's catalogue. The gateway has no source for that fact and must not pretend to.
      expect(toStatusKey('waiting_on_finance')).toBe('waiting_on_finance');
    });

    it('still refuses an EMPTY status — "set it to nothing" is a malformed request', () => {
      expect(() => toStatusKey()).toThrow(BadRequestException);
      expect(() => toStatusKey('')).toThrow(BadRequestException);
      expect(() => toStatusKey('   ')).toThrow(BadRequestException);
    });
  });

  describe('status category (feature 032) — closed, so fail-closed', () => {
    it('maps the six; absent → unspecified (no filter)', () => {
      expect(toStatusCategoryWire('new')).toBe('CONVERSATION_STATUS_CATEGORY_NEW');
      expect(toStatusCategoryWire('on_hold')).toBe('CONVERSATION_STATUS_CATEGORY_ON_HOLD');
      expect(toStatusCategoryWire('closed')).toBe('CONVERSATION_STATUS_CATEGORY_CLOSED');
      expect(toStatusCategoryWire()).toBe('CONVERSATION_STATUS_CATEGORY_UNSPECIFIED');
    });

    // An unknown category dropped rather than refused would widen the query to every conversation.
    it.each(['OPEN', 'onhold', 'on-hold', 'resolved', 'snoozed'])(
      'rejects the unknown category %p',
      (c) => {
        expect(() => toStatusCategoryWire(c)).toThrow(BadRequestException);
      },
    );
  });

  describe('macro actions (feature 013)', () => {
    it('maps the three v1 action types', () => {
      expect(toMacroActionTypeWire('set_status')).toBe('MACRO_ACTION_TYPE_SET_STATUS');
      expect(toMacroActionTypeWire('add_label')).toBe('MACRO_ACTION_TYPE_ADD_LABEL');
      expect(toMacroActionTypeWire('assign')).toBe('MACRO_ACTION_TYPE_ASSIGN');
    });

    // No default exists for "what should this action do" — guessing would silently perform a
    // different mutation than the author intended.
    it.each(['', undefined, 'send_message', 'SET_STATUS', 'apply_sla', 'close'])(
      'rejects the action type %p rather than defaulting',
      (type) => {
        expect(() => toMacroActionTypeWire(type as string | undefined)).toThrow(BadRequestException);
      },
    );

    // Feature 032: a SET_STATUS value is a KEY and travels unchanged. It used to be normalised to a
    // proto enum name here; the account's catalogue is the only authority now, and `chats` checks it at
    // define AND at apply.
    it('validates a whole action list and passes a SET_STATUS key through', () => {
      expect(
        toMacroActionsWire([
          { type: 'set_status', value: 'vip_pending' },
          { type: 'add_label', value: 'label-1' },
        ]),
      ).toEqual([
        { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'vip_pending' },
        { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'label-1' },
      ]);
    });

    it('rejects an empty list and a blank value (the shape checks that remain at this tier)', () => {
      expect(() => toMacroActionsWire([])).toThrow(BadRequestException);
      expect(() => toMacroActionsWire(undefined)).toThrow(BadRequestException);
      expect(() => toMacroActionsWire([{ type: 'add_label', value: '   ' }])).toThrow(
        BadRequestException,
      );
      expect(() => toMacroActionsWire([{ type: 'set_status', value: '  ' }])).toThrow(
        BadRequestException,
      );
    });

    it('rejects the whole list when ANY action is invalid (no partial mapping)', () => {
      expect(() =>
        toMacroActionsWire([
          { type: 'set_status', value: 'open' },
          { type: 'send_message', value: 'hi' },
        ]),
      ).toThrow(BadRequestException);
    });
  });

  /**
   * Feature 023 (roadmap 4.18). The edge and the owning service both bound the title, and the two
   * numbers are DUPLICATED rather than shared — the gateway does not import a service's internals, and
   * `@crm/common` is for things both tiers own. A duplicated constant is only safe while something
   * checks it, so this reads the real declaration rather than trusting the comment beside it.
   *
   * If they drifted apart, the edge would reject titles the service would have accepted (or worse, the
   * other way round: accept one the service refuses, turning a 400 into a confusing round trip).
   */
  it('normalises a title, and refuses rather than truncating (feature 023)', () => {
    expect(toSubjectWire('  выплата\n  задерживается  ')).toBe('выплата задерживается');
    expect(toSubjectWire('a'.repeat(MAX_SUBJECT_LENGTH))).toHaveLength(MAX_SUBJECT_LENGTH);
    expect(() => toSubjectWire('a'.repeat(MAX_SUBJECT_LENGTH + 1))).toThrow(BadRequestException);
    for (const blank of [undefined, '', '   ', '\n\t']) {
      expect(() => toSubjectWire(blank)).toThrow(BadRequestException);
    }
  });

  it('the edge cap equals the service cap — the duplication is pinned, not trusted', () => {
    const derive = readFileSync(
      join(__dirname, '..', '..', '..', 'chats', 'src', 'subject', 'subject.derive.ts'),
      'utf8',
    );
    const declared = /MAX_SUBJECT_LENGTH\s*=\s*(\d+)/.exec(derive)?.[1];
    expect(declared).toBeDefined(); // the scan found the declaration
    expect(Number(declared)).toBe(MAX_SUBJECT_LENGTH);
  });

  it('error messages name the field and the allow-list, nothing else', () => {
    try {
      toKindWire('private_note');
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as BadRequestException).message;
      expect(msg).toContain('kind');
      expect(msg).toContain('note');
      expect(msg).not.toContain('private_note'); // never echo the raw client value back
    }
  });
});
