import { RpcException } from '@nestjs/microservices';
import { assertNotShelved, isShelfState, shelfTransition, NOT_SHELVED } from './shelf';

/**
 * W27 / 036 — the transition table IS the feature's law (spec FR-006/008/010; research R3).
 * Every audit action derives from (from, to) here and nowhere else.
 */
describe('the shelf transition table', () => {
  it('names the four verbs from their transitions', () => {
    expect(shelfTransition(null, 'suspended')).toEqual({ kind: 'change', action: 'conversation.suspend' });
    expect(shelfTransition(null, 'deleted')).toEqual({ kind: 'change', action: 'conversation.delete' });
    expect(shelfTransition('suspended', null)).toEqual({ kind: 'change', action: 'conversation.release' });
    expect(shelfTransition('deleted', null)).toEqual({ kind: 'change', action: 'conversation.restore' });
  });

  it('delete WINS over suspended — and the restore then returns to ordinary, not to suspended', () => {
    expect(shelfTransition('suspended', 'deleted')).toEqual({ kind: 'change', action: 'conversation.delete' });
    // The "returns to ordinary" half is structural: a transition's target is NONE, never a memory.
    expect(shelfTransition('deleted', null)).toEqual({ kind: 'change', action: 'conversation.restore' });
  });

  it('⛔ deleted → suspended is REFUSED: a delete is undone deliberately, never sideways', () => {
    expect(shelfTransition('deleted', 'suspended')).toEqual({ kind: 'refused', reason: 'restore first' });
  });

  it('same → same is UNCHANGED for all three states — the idempotent repeat writes nothing (FR-010)', () => {
    expect(shelfTransition(null, null)).toEqual({ kind: 'unchanged' });
    expect(shelfTransition('suspended', 'suspended')).toEqual({ kind: 'unchanged' });
    expect(shelfTransition('deleted', 'deleted')).toEqual({ kind: 'unchanged' });
  });

  it('the vocabulary is closed: exactly suspended and deleted', () => {
    expect(isShelfState('suspended')).toBe(true);
    expect(isShelfState('deleted')).toBe(true);
    expect(isShelfState('archived')).toBe(false);
    expect(isShelfState('')).toBe(false);
  });
});

describe('the mutation guard and the predicate', () => {
  it('assertNotShelved refuses BOTH shelved states and passes the ordinary row', () => {
    expect(() => assertNotShelved({ shelved_state: 'suspended' })).toThrow(RpcException);
    expect(() => assertNotShelved({ shelved_state: 'deleted' })).toThrow(RpcException);
    expect(() => assertNotShelved({ shelved_state: null })).not.toThrow();
    expect(() => assertNotShelved(null)).not.toThrow();
  });

  it('the exclusion predicate is the literal one every work-feeding query spreads', () => {
    // Pinned as a VALUE: `shelf.exclusion.spec.ts` walks the consuming sites for this import, so
    // the shape here and the shape there must stay one thing.
    expect(NOT_SHELVED).toEqual({ shelved_state: null });
  });
});
