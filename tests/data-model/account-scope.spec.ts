import { parseSchema, SERVICES, hasField, columnIsIndexed } from './schema-scan';

/**
 * T2 / SC-003 / FR-011 (Principle I, NON-NEGOTIABLE): every tenant-owned model carries an
 * indexed `account_id` scope column so isolation (feature 007) attaches without a rewrite.
 *
 * "Tenant-owned" = any model that is NOT a pure join edge (a composite `@@id([...])` with no
 * field-level `@id`). Join tables (UserRole, PlayerBrand, ConversationLabel) are scoped through
 * their in-schema parents and are exempt. Fails on the empty scaffolds (no models yet).
 */
describe('account-scope coverage (Principle I)', () => {
  // Known tenant-owned models — pins the invariant so an empty schema fails the test.
  const EXPECTED: Record<string, string[]> = {
    auth: ['User', 'Credential', 'Role'],
    users: ['Operator', 'Player'],
    brands: ['Brand', 'BrandAccessRule'],
    chats: ['Conversation', 'Message', 'Label', 'Macro', 'Automation'],
  };

  it.each(SERVICES)('%s: every expected tenant model is present', (service) => {
    const names = parseSchema(service).map((m) => m.name);
    for (const expected of EXPECTED[service]!) {
      expect(names).toContain(expected);
    }
  });

  it.each(SERVICES)('%s: every non-join model declares account_id', (service) => {
    const tenant = parseSchema(service).filter((m) => !m.isJoinTable);
    expect(tenant.length).toBeGreaterThan(0);
    for (const model of tenant) {
      expect(hasField(model, 'account_id')).toBe(true);
    }
  });

  it.each(SERVICES)('%s: every account_id column is indexed', (service) => {
    for (const model of parseSchema(service).filter((m) => hasField(m, 'account_id'))) {
      expect(columnIsIndexed(model, 'account_id')).toBe(true);
    }
  });
});
