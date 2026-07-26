import { BadRequestException } from '@nestjs/common';
import {
  toKindWire,
  toMacroActionsWire,
  toMacroActionTypeWire,
  toProjectionWire,
  toStatusWire,
  toStatusWireRequired,
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

  describe('status', () => {
    it('maps documented statuses; absent → unspecified (no filter)', () => {
      expect(toStatusWire('open')).toBe('CONVERSATION_STATUS_OPEN');
      expect(toStatusWire('snoozed')).toBe('CONVERSATION_STATUS_SNOOZED');
      expect(toStatusWire()).toBe('CONVERSATION_STATUS_UNSPECIFIED');
    });

    // Previously an unknown filter value silently widened the query to "all statuses".
    it.each(['OPEN', 'closed', 'done', 'pendng'])('rejects unknown status filter %p', (s) => {
      expect(() => toStatusWire(s)).toThrow(BadRequestException);
    });

    it('requires a concrete status for a mutation', () => {
      expect(toStatusWireRequired('resolved')).toBe('CONVERSATION_STATUS_RESOLVED');
      expect(() => toStatusWireRequired()).toThrow(BadRequestException);
      expect(() => toStatusWireRequired('')).toThrow(BadRequestException);
    });
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

    it('validates a whole action list and normalises a SET_STATUS value to its wire name', () => {
      expect(
        toMacroActionsWire([
          { type: 'set_status', value: 'pending' },
          { type: 'add_label', value: 'label-1' },
        ]),
      ).toEqual([
        { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
        { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'label-1' },
      ]);
    });

    it('rejects an empty list, a missing value, and an unknown status inside SET_STATUS', () => {
      expect(() => toMacroActionsWire([])).toThrow(BadRequestException);
      expect(() => toMacroActionsWire(undefined)).toThrow(BadRequestException);
      expect(() => toMacroActionsWire([{ type: 'add_label', value: '   ' }])).toThrow(
        BadRequestException,
      );
      expect(() => toMacroActionsWire([{ type: 'set_status', value: 'closed' }])).toThrow(
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
