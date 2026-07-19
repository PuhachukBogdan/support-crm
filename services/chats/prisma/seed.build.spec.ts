import { buildSeed } from './seed.build';
import { SEED_ACCOUNT_ID, SEED_BRAND_ID, SEED_PLAYER_ID } from '@crm/common';

/**
 * US1 (feature 008): the chats seed builder yields a label + two conversations (reserved classification
 * exercised) + messages (incl. a private note) + a conversation-label link. Pure — no DB (Track A).
 */
describe('chats seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of [...seed.labels, ...seed.conversations, ...seed.messages]) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('conversations reference the shared brand + player and exercise the reserved classification', () => {
    for (const c of seed.conversations) {
      expect(c.brand_id).toBe(SEED_BRAND_ID);
      expect(c.player_id).toBe(SEED_PLAYER_ID);
    }
    // at least one conversation is classified (reserved fields, ADR 0027)
    expect(seed.conversations.some((c) => c.category === 'billing' && c.classified_by === 'seed')).toBe(true);
  });

  it('includes at least one private (internal) message', () => {
    expect(seed.messages.some((m) => m.private === true)).toBe(true);
  });

  it('links the open conversation to the label', () => {
    expect(seed.conversationLabels.length).toBeGreaterThan(0);
  });
});
