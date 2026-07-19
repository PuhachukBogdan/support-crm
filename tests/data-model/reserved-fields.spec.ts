import { parseSchema, getField, hasField } from './schema-scan';

/**
 * T4 / SC-005 / FR-012, FR-013 (ADR 0027 + ADR 0032): the Conversation (ticket) reserves the
 * classification fields `category` / `sub_category` / `classified_by` (all NULLABLE — an
 * unclassified ticket is valid) and the `player_id` feed key, so AI classification (Phase 15)
 * and the unified player feed (4.3/4.13) land with no core-table migration.
 */
describe('reserved classification fields on Conversation (ADR 0027)', () => {
  const conversation = () => parseSchema('chats').find((m) => m.name === 'Conversation');

  it('Conversation exists in the chats schema', () => {
    expect(conversation()).toBeDefined();
  });

  it.each(['category', 'sub_category', 'classified_by'])(
    'reserves %s as a nullable column',
    (name) => {
      const model = conversation()!;
      const field = getField(model, name);
      expect(field).toBeDefined();
      expect(field!.optional).toBe(true);
    },
  );

  it('carries the player_id feed key', () => {
    expect(hasField(conversation()!, 'player_id')).toBe(true);
  });
});
