import { parseSchema, hasField, type Service } from './schema-scan';
import { SCOPED_MODELS as AUTH } from '../../services/auth/src/prisma.scoped-models';
import { SCOPED_MODELS as USERS } from '../../services/users/src/prisma.scoped-models';
import { SCOPED_MODELS as BRANDS } from '../../services/brands/src/prisma.scoped-models';
import { SCOPED_MODELS as CHATS } from '../../services/chats/src/prisma.scoped-models';

/**
 * US1 / SC-001 (feature 007): each service's account-scoped model allow-list (the set the isolation
 * extension enforces on) MUST EQUAL the set of models that actually declare `account_id` in its
 * schema. This closes the "someone added a tenant table but forgot to enroll it" gap — a new
 * account_id model missing from the allow-list fails the build; a stale entry does too.
 */
const LISTS: Record<Service, readonly string[]> = {
  auth: AUTH,
  users: USERS,
  brands: BRANDS,
  chats: CHATS,
};

describe('account-scope allow-list coverage (Principle I)', () => {
  it.each(Object.keys(LISTS) as Service[])(
    '%s: SCOPED_MODELS == models declaring account_id in the schema',
    (service) => {
      const fromSchema = parseSchema(service)
        .filter((m) => hasField(m, 'account_id'))
        .map((m) => m.name)
        .sort();
      const fromList = [...LISTS[service]].sort();
      expect(fromList).toEqual(fromSchema);
    },
  );
});
