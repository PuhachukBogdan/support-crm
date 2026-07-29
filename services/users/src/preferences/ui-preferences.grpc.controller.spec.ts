import { Metadata } from '@grpc/grpc-js';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { defaultUiPreferences } from '@crm/common';
import { UiPreferencesController } from './ui-preferences.grpc.controller';
import type { UiPreferencesRepository } from './ui-preferences.repository';

/**
 * `OperatorUiPreferencesService` handlers (feature 021, US1–US3).
 *
 * The repository is a stub here because what is under test is the CONTRACT the controller keeps:
 * which metadata it reads, what it refuses, and — the two that matter most — that a refusal reaches
 * the repository not at all, and that a rejection never carries the submitted value.
 */

function harness() {
  const stored: Record<string, string> = {};
  const repo = {
    read: jest.fn(async () => ({ ...defaultUiPreferences(), ...stored })),
    apply: jest.fn(async (_a: string, _u: string, entries: ReadonlyArray<readonly [string, string]>) => {
      for (const [k, v] of entries) stored[k] = v;
      return { ...defaultUiPreferences(), ...stored };
    }),
  };
  return { ctl: new UiPreferencesController(repo as unknown as UiPreferencesRepository), repo };
}

function md(over: Record<string, string> = {}): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'user-1');
  for (const [k, v] of Object.entries(over)) m.set(k, v);
  return m;
}

function codeOf(e: unknown): number | undefined {
  return (e as RpcException)?.getError?.() &&
    typeof (e as RpcException).getError() === 'object'
    ? ((e as RpcException).getError() as { code?: number }).code
    : undefined;
}

describe('*** get: the complete set, for the caller and nobody else ***', () => {
  it('returns every catalogue key', async () => {
    const h = harness();
    const res = await h.ctl.getOperatorUiPreferences({}, md());
    expect(Object.keys(res.values).sort()).toEqual(Object.keys(defaultUiPreferences()).sort());
  });

  it('addresses the CALLER from the metadata — never a field in the request', async () => {
    const h = harness();
    // The request message is empty by design. Even if a caller invents a subject field, it is ignored:
    // there is no code path that reads one.
    await h.ctl.getOperatorUiPreferences({ authUserId: 'someone-else' }, md());
    expect(h.repo.read).toHaveBeenCalledWith('acc-1', 'user-1');
  });
});

describe('*** fail-closed on either half of the identity ***', () => {
  it('refuses with no account context', async () => {
    const h = harness();
    const m = new Metadata();
    m.set('x-actor-user-id', 'user-1');
    await expect(h.ctl.getOperatorUiPreferences({}, m)).rejects.toBeInstanceOf(RpcException);
    expect(h.repo.read).not.toHaveBeenCalled();
  });

  it('refuses with no person identity — an empty user id would address a SHARED row', async () => {
    // Subtler than the account case and worse: every other surface in this service keys on a record
    // id, but this one keys on the caller, so an empty id is not "no result" — it is one row that
    // every context-less call would share.
    const h = harness();
    const m = new Metadata();
    m.set('x-actor-account-id', 'acc-1');
    await expect(h.ctl.getOperatorUiPreferences({}, m)).rejects.toBeInstanceOf(RpcException);
    expect(h.repo.read).not.toHaveBeenCalled();
  });

  it('refuses with no metadata at all', async () => {
    const h = harness();
    await expect(h.ctl.getOperatorUiPreferences({}, undefined)).rejects.toBeInstanceOf(RpcException);
  });
});

describe('*** update: validated whole, then written ***', () => {
  it('applies a valid patch and returns the complete resulting set', async () => {
    const h = harness();
    const res = await h.ctl.updateOperatorUiPreferences({ values: { theme_mode: 'dark' } }, md());
    expect(res.values.theme_mode).toBe('dark');
    expect(res.values.font_size_step).toBe('default');
  });

  it.each([
    ['an unknown key', { last_searched_player: 'p-1' }],
    ['a value outside its set', { theme_mode: 'purple' }],
    ['an empty patch', {}],
    ['a patch mixing one valid and one invalid key', { theme_mode: 'dark', nope: 'x' }],
  ])('refuses %s, and writes NOTHING', async (_label, values) => {
    const h = harness();
    await expect(
      h.ctl.updateOperatorUiPreferences({ values }, md()),
    ).rejects.toBeInstanceOf(RpcException);
    // FR-005: the whole point. A refusal that already wrote the valid half is the worst outcome here.
    expect(h.repo.apply).not.toHaveBeenCalled();
  });

  it('refuses a missing `values` map entirely', async () => {
    const h = harness();
    await expect(h.ctl.updateOperatorUiPreferences({}, md())).rejects.toBeInstanceOf(RpcException);
    expect(h.repo.apply).not.toHaveBeenCalled();
  });

  it('a bad VALUE is INVALID_ARGUMENT, names the key, and never echoes the value', async () => {
    // Safe to name here: the key MATCHED the closed catalogue, so it is a catalogue literal rather
    // than caller input — and it is the case a settings screen can act on.
    const h = harness();
    const secret = 'someone@example.com';
    const err = await h.ctl
      .updateOperatorUiPreferences({ values: { theme_mode: secret } }, md())
      .catch((e: unknown) => e);

    expect(codeOf(err)).toBe(GrpcStatus.INVALID_ARGUMENT);
    const text = JSON.stringify((err as RpcException).getError());
    expect(text).toContain('theme_mode');
    // Principle IV: echoing arbitrary submitted input into a message is how it reaches a log.
    expect(text).not.toContain(secret);
  });

  it('⚠️ an UNKNOWN key is NOT reflected back — it is caller input by definition', async () => {
    // The distinction found while repairing the live run: an unknown key is arbitrary text the caller
    // chose, so naming it would reflect unvalidated input through the gateway and into its logs. The
    // closed key list is offered instead — it is not a secret, and it is the actionable half.
    const h = harness();
    const injected = 'user@example.com<script>';
    const err = await h.ctl
      .updateOperatorUiPreferences({ values: { [injected]: 'x' } }, md())
      .catch((e: unknown) => e);

    const text = JSON.stringify((err as RpcException).getError());
    expect(text).not.toContain(injected);
    expect(text).not.toContain('example.com');
    expect(text).toContain('theme_mode'); // the known keys, from the catalogue
  });
});

describe('*** view-as preview: read the real caller, refuse the write (FR-017) ***', () => {
  it('a read under preview returns the REAL caller’s preferences', async () => {
    // `x-actor-user-id` carries the real caller by design — only the effective ROLE changes under a
    // preview. A preview changes whose data you look at, not whose eyes you look with.
    const h = harness();
    await h.ctl.getOperatorUiPreferences({}, md({ 'x-is-preview': 'true' }));
    expect(h.repo.read).toHaveBeenCalledWith('acc-1', 'user-1');
  });

  it('a write under preview is refused — the independent second tier', async () => {
    const h = harness();
    const err = await h.ctl
      .updateOperatorUiPreferences({ values: { theme_mode: 'dark' } }, md({ 'x-is-preview': 'true' }))
      .catch((e: unknown) => e);

    expect(codeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(h.repo.apply).not.toHaveBeenCalled();
  });

  it('refuses BEFORE validating — a preview write is refused whatever it contains', async () => {
    // Order matters for the message the caller gets: "read-only preview" is the true reason, and
    // reporting a validation error instead would send someone hunting the wrong problem.
    const h = harness();
    const err = await h.ctl
      .updateOperatorUiPreferences({ values: {} }, md({ 'x-is-preview': 'true' }))
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe(GrpcStatus.PERMISSION_DENIED);
  });

  it('`x-is-preview` is only honoured as the literal "true"', async () => {
    // Every reader in the product tests for the literal, and an absent header must not be conflated
    // with the string 'false'.
    const h = harness();
    await expect(
      h.ctl.updateOperatorUiPreferences({ values: { theme_mode: 'dark' } }, md({ 'x-is-preview': 'false' })),
    ).resolves.toBeDefined();
  });
});

describe('*** the boundary: no permission, no role, no audit (FR-015/FR-016/FR-018) ***', () => {
  it('a caller holding NO permissions at all is served normally', async () => {
    // Nothing here is gated. If this ever starts failing, a permission has been introduced into a
    // record ADR 0035 says may never hold one.
    const h = harness();
    const m = md();
    m.set('x-actor-permissions', '');
    await expect(h.ctl.getOperatorUiPreferences({}, m)).resolves.toBeDefined();
  });

  it('a caller holding EVERY permission gets exactly the same set — nothing is masked', async () => {
    const h = harness();
    const m = md();
    m.set('x-actor-permissions', 'crm.contact.read_pii,platform.view_as,settings.manage');
    m.set('x-actor-effective-role', 'super_admin');
    const privileged = await h.ctl.getOperatorUiPreferences({}, m);

    const plain = await harness().ctl.getOperatorUiPreferences({}, md());
    expect(privileged.values).toEqual(plain.values);
  });

  it('the effective role does not change the result — this is not a masked surface', async () => {
    const h = harness();
    const low = await h.ctl.getOperatorUiPreferences({}, md({ 'x-actor-effective-role': 'support' }));
    const high = await h.ctl.getOperatorUiPreferences({}, md({ 'x-actor-effective-role': 'admin' }));
    expect(low.values).toEqual(high.values);
  });
});
