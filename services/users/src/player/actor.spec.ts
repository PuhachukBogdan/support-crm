import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { allowedFields, visibleTiersFor } from '@crm/common';
import { readPlayerActor } from './actor';

/**
 * T015 (feature 018) — the caller context, and the fail-closed direction of an ABSENT role.
 *
 * The last block is the one worth having. Masking is a function of the role, so "what happens when the
 * role does not arrive" is a privilege question, and the answer must be *the most restricted tier* — not
 * a default chosen in a metadata reader, and certainly not a privileged one. It is asserted here against
 * the real policy rather than against a comment.
 */
function md(entries: Record<string, string> = {}): Metadata {
  const m = new Metadata();
  for (const [k, v] of Object.entries(entries)) m.set(k, v);
  return m;
}

const codeOf = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return ((err as RpcException).getError() as { code?: number })?.code;
  }
};

describe('*** no account context ⇒ refused before anything else *** (Principle I)', () => {
  it.each([
    ['nothing at all', {}],
    ['a user but no account', { 'x-actor-user-id': 'user-1' }],
    ['permissions but no account', { 'x-actor-permissions': 'crm.contact.view' }],
    ['an empty account', { 'x-actor-account-id': '' }],
  ])('%s is PERMISSION_DENIED', (_label, entries) => {
    expect(codeOf(() => readPlayerActor(md(entries)))).toBe(GrpcStatus.PERMISSION_DENIED);
  });

  it('undefined metadata is refused, not treated as an internal call', () => {
    expect(codeOf(() => readPlayerActor(undefined))).toBe(GrpcStatus.PERMISSION_DENIED);
  });
});

describe('the context is read as the gateway sends it', () => {
  it('reads all five values', () => {
    const actor = readPlayerActor(
      md({
        'x-actor-account-id': 'acc-1',
        'x-actor-user-id': 'user-1',
        'x-actor-permissions': 'crm.contact.view,crm.inbox.view',
        'x-actor-effective-role': 'am',
        'x-is-preview': 'true',
      }),
    );
    expect(actor).toEqual({
      accountId: 'acc-1',
      userId: 'user-1',
      permissions: ['crm.contact.view', 'crm.inbox.view'],
      effectiveRole: 'am',
      underPreview: true,
    });
  });

  it('a Buffer value decodes like a string — the DEFENSIVE branch, exercised honestly', () => {
    /**
     * ⚠️ Finding, worth recording rather than papering over: **grpc-js refuses to `set` a Buffer on a
     * key that does not end in `-bin`** ("keys that don't end with '-bin' must have String values"), and
     * metadata received from the wire decodes those keys as strings. So the Buffer branch that every
     * caller-context reader in this product carries is **defensive, not a live path** — the first draft
     * of this test tried to build such metadata through the real API and was rejected by it.
     *
     * The branch is still worth keeping and worth covering: these readers accept anything shaped like
     * metadata, and a future fake, proxy or interceptor could hand one over. So it is exercised through
     * a metadata-shaped stub, which is honest about what is being tested instead of pretending the
     * transport allows it.
     */
    const stub = {
      get: (key: string) =>
        key === 'x-actor-account-id'
          ? [Buffer.from('acc-1', 'utf8')]
          : key === 'x-actor-effective-role'
            ? [Buffer.from('vip_support', 'utf8')]
            : [],
    } as unknown as Metadata;

    const actor = readPlayerActor(stub);
    expect(actor.accountId).toBe('acc-1');
    expect(actor.effectiveRole).toBe('vip_support');
  });

  it('an empty permission list is [], not [""]', () => {
    expect(readPlayerActor(md({ 'x-actor-account-id': 'acc-1' })).permissions).toEqual([]);
    expect(
      readPlayerActor(md({ 'x-actor-account-id': 'acc-1', 'x-actor-permissions': '' })).permissions,
    ).toEqual([]);
  });

  it('the preview marker is only true for the literal "true"', () => {
    for (const v of ['false', 'True', '1', 'yes', '']) {
      expect(
        readPlayerActor(md({ 'x-actor-account-id': 'a', 'x-is-preview': v })).underPreview,
      ).toBe(false);
    }
  });
});

describe('*** an ABSENT effective role fails closed to the most restricted tier ***', () => {
  it('it is returned empty rather than defaulted', () => {
    // The reader must NOT choose a role. Substituting one here would put a privilege decision in a
    // metadata parser, where nobody would look for it.
    expect(readPlayerActor(md({ 'x-actor-account-id': 'acc-1' })).effectiveRole).toBe('');
  });

  it('and the POLICY then grants it open fields only — asserted against the real policy', () => {
    const role = readPlayerActor(md({ 'x-actor-account-id': 'acc-1' })).effectiveRole;
    expect(visibleTiersFor(role)).toEqual(['open']);

    // The consequence that matters: nothing operational, nothing portfolio-side, nothing top-tier.
    const fields = allowedFields(role, { attachedToSubject: false });
    for (const withheld of [
      'vip',
      'segment',
      'custom_attributes',
      'am_notes',
      'preferences',
      'portfolio',
      'gr8_snapshot',
    ]) {
      expect({ withheld, visible: fields.has(withheld) }).toEqual({ withheld, visible: false });
    }
  });

  it('an unknown role is treated the same way — never as privileged', () => {
    expect(visibleTiersFor('some_role_added_next_year')).toEqual(['open']);
  });
});
