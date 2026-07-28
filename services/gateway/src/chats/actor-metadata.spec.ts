import type { EffectivePermissions } from '@crm/common';
import { buildActorMetadata } from './actor-metadata';
import type { RequestClaims } from '../auth/auth.guard';

/**
 * T013 (feature 018) — **the riskiest change in the feature, pinned.**
 *
 * This builder is used by every chats route, the uploads routes and the exports routes. Feature 018
 * extends it for two headers the owning services now need, and the whole point of this file is the
 * first block: **no existing header changes value for the same input.** Eleven shipped controllers
 * depend on that, and a silent change in one of them would surface as an authorization failure on a
 * feature nobody touched.
 *
 * The second block is the repair. `x-is-preview` has had a parameter since feature 012 and **no route
 * has ever passed it** — so every audit entry in the product has recorded "no preview was active"
 * regardless of the truth, and one owning service's own preview refusal could never fire. Passing the
 * resolved effective object supplies it, along with the effective role that masking needs.
 */
const CLAIMS: RequestClaims = {
  userId: 'user-1',
  accountId: 'acc-1',
  roles: ['admin'],
  brands: ['brand-a', 'brand-b'],
};

const effective = (over: Partial<EffectivePermissions> = {}): EffectivePermissions => ({
  roleKey: 'admin',
  permissionKeys: ['crm.inbox.view', 'crm.contact.view'],
  mode: 'inherited',
  isPreview: false,
  readOnly: false,
  ...over,
});

const read = (md: ReturnType<typeof buildActorMetadata>, key: string): string | undefined => {
  const v = md.get(key)[0];
  return v === undefined ? undefined : String(v);
};

describe('*** every previously-set header keeps its EXACT value *** (11 shipped controllers)', () => {
  const legacy = buildActorMetadata(CLAIMS, ['crm.inbox.view', 'crm.contact.view']);
  const modern = buildActorMetadata(CLAIMS, effective());

  it.each([
    ['x-actor-account-id', 'acc-1'],
    ['x-actor-user-id', 'user-1'],
    ['x-actor-permissions', 'crm.inbox.view,crm.contact.view'],
    ['x-actor-brands', 'brand-a,brand-b'],
  ])('%s is unchanged', (key, expected) => {
    expect(read(legacy, key)).toBe(expected);
    expect(read(modern, key)).toBe(expected);
  });

  it('the array form and the object form produce the SAME old headers', () => {
    // The migration of the eleven call sites was mechanical, so this is the assertion that says the
    // mechanical change was safe: for equivalent input, every pre-existing key matches.
    for (const key of [
      'x-actor-account-id',
      'x-actor-user-id',
      'x-actor-role',
      'x-actor-permissions',
      'x-actor-brands',
    ]) {
      expect(read(modern, key)).toBe(read(legacy, key));
    }
  });

  it('an empty permission set is still an empty STRING, not an absent key', () => {
    // A reader splits on ',' and filters empties. An absent key and '' must stay interchangeable in the
    // direction they already were, or a service starts refusing on a shape it used to accept.
    expect(read(buildActorMetadata(CLAIMS, []), 'x-actor-permissions')).toBe('');
    expect(read(buildActorMetadata(CLAIMS, effective({ permissionKeys: [] })), 'x-actor-permissions')).toBe('');
    expect(read(buildActorMetadata(CLAIMS, undefined), 'x-actor-permissions')).toBe('');
  });

  it('brands are omitted when absent or empty, exactly as before', () => {
    const noBrands = buildActorMetadata({ ...CLAIMS, brands: undefined }, effective());
    const emptyBrands = buildActorMetadata({ ...CLAIMS, brands: [] }, effective());
    expect(noBrands.get('x-actor-brands')).toHaveLength(0);
    expect(emptyBrands.get('x-actor-brands')).toHaveLength(0);
  });
});

describe('*** x-actor-role still carries who they ARE, not who they act as ***', () => {
  it('it comes from the claims, even when the effective role differs', () => {
    // The distinction the feature turns on. Under a preview the owner's real role is `admin` and the
    // acted-as role is the previewed one; conflating them would mask a previewed session as the owner.
    const md = buildActorMetadata(CLAIMS, effective({ roleKey: 'support_agent', isPreview: true }));
    expect(read(md, 'x-actor-role')).toBe('admin');
    expect(read(md, 'x-actor-effective-role')).toBe('support_agent');
  });

  it('a caller with no roles still gets the key, empty — unchanged behaviour', () => {
    expect(read(buildActorMetadata({ ...CLAIMS, roles: [] }, effective()), 'x-actor-role')).toBe('');
  });
});

describe('*** the two new headers ***', () => {
  it('the effective role is forwarded when the object form is used', () => {
    expect(read(buildActorMetadata(CLAIMS, effective({ roleKey: 'am' })), 'x-actor-effective-role')).toBe('am');
  });

  it('…and is ABSENT for the legacy array form — the addition is opt-in', () => {
    // Which is what makes the eleven-site migration reviewable: a route that was not updated forwards
    // exactly what it forwarded before.
    expect(buildActorMetadata(CLAIMS, ['x']).get('x-actor-effective-role')).toHaveLength(0);
  });

  it('an empty effective role sets no key rather than an empty one', () => {
    // Fail-closed at the reader: an absent role must degrade to the most restricted tier, and it cannot
    // do that if it receives '' and treats it as a role name.
    expect(
      buildActorMetadata(CLAIMS, effective({ roleKey: '' })).get('x-actor-effective-role'),
    ).toHaveLength(0);
  });

  it('*** x-is-preview is set from the resolved flag — the repair ***', () => {
    // Before this, the parameter existed and no route passed it, so `under_preview` was false on every
    // audit entry in the product and one service's preview refusal was unreachable.
    expect(read(buildActorMetadata(CLAIMS, effective({ isPreview: true })), 'x-is-preview')).toBe('true');
  });

  it('it is ABSENT rather than "false" when no preview is active', () => {
    // Every reader in the product tests for the literal 'true'. Sending 'false' would work today and
    // would break the first reader that checks presence instead of value.
    expect(buildActorMetadata(CLAIMS, effective({ isPreview: false })).get('x-is-preview')).toHaveLength(0);
  });

  it('the explicit opts flag still works and still wins', () => {
    // The pre-existing escape hatch, kept: a caller that knows it is in a preview can say so without an
    // effective object.
    expect(read(buildActorMetadata(CLAIMS, ['x'], { preview: true }), 'x-is-preview')).toBe('true');
  });
});
