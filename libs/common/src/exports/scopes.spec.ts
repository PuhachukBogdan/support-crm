import { SYSTEM_CATALOGUE } from '../../../../services/auth/src/rbac/catalogue';
import { UPLOAD_PURPOSES } from '../uploads/purposes';
import { canMassExportContacts } from '../policy/field-tiers';
import {
  EXPORT_FAILURE_REASONS,
  EXPORT_SCOPES,
  EXPORT_SCOPE_NAMES,
  EXPORT_STATUSES,
  isExportScope,
  scopeOf,
  TERMINAL_EXPORT_STATUSES,
} from './scopes';

/**
 * T018 (feature 017, US1) — the scope catalogue's CLAIMS, as tests.
 *
 * Every catalogue in this project earns its assertions: 016's `always` derivative policy, 015's
 * action statuses, 014's action vocabulary. A row that merely *says* it may not contain contact data
 * is a comment; a build that fails when a row says otherwise without the gate is a control.
 */
describe('the catalogue is closed (FR-003)', () => {
  it('an unknown scope resolves to nothing — there is no permissive default', () => {
    for (const unknown of ['', 'nonsense', 'Conversations', 'default', '__proto__', 'toString']) {
      expect(isExportScope(unknown)).toBe(false);
      expect(scopeOf(unknown)).toBeUndefined();
    }
    expect(scopeOf(undefined)).toBeUndefined();
  });

  it('an inherited Object property is not a scope (a lookup, not a prototype walk)', () => {
    // `'constructor' in EXPORT_SCOPES` is true; membership must not be, or a caller gets a function
    // where a row belongs and takes whatever branch handles a falsy entry.
    expect(isExportScope('constructor')).toBe(false);
    expect(scopeOf('valueOf')).toBeUndefined();
  });

  it('v1 has EXACTLY one scope, and it is conversations', () => {
    // Deliberately an equality, not a `toContain`: the operator scoped v1 to conversations (Q1 → A),
    // and a second row arriving unnoticed is exactly what this asserts against. Player/contact data
    // and the audit log are each a separate decision with their own key.
    expect(EXPORT_SCOPE_NAMES).toEqual(['conversations']);
  });
});

describe('every row is well-formed', () => {
  it.each(EXPORT_SCOPE_NAMES)('%s: names a real permission key', (name) => {
    // Unlike an upload purpose, `permission` is never null here: an export is never "authenticated is
    // sufficient". One key per scope, so a future contact-bearing scope cannot inherit this grant.
    const { permission } = EXPORT_SCOPES[name];
    expect(typeof permission).toBe('string');
    expect(SYSTEM_CATALOGUE.map((e) => e.key)).toContain(permission);
  });

  it.each(EXPORT_SCOPE_NAMES)('%s: caps, TTL and quota are positive and bounded', (name) => {
    const s = EXPORT_SCOPES[name];
    expect(s.rowLimit).toBeGreaterThan(0);
    expect(s.maxBytes).toBeGreaterThan(0);
    expect(s.ttlSeconds).toBeGreaterThan(0);
    expect(s.quotaMax).toBeGreaterThan(0);
    expect(s.quotaWindowSeconds).toBeGreaterThan(0);
  });

  it.each(EXPORT_SCOPE_NAMES)(
    '%s: maxBytes fits inside the purpose cap the artefact is stored through',
    (name) => {
      // The artefact goes through `CreateUpload` with the `conversation_export` purpose, whose cap is
      // itself inside the 12 MB uploads channel (016). If a scope could exceed the purpose cap, the
      // export would produce a file that its own storage path then refuses — a failure configured
      // into the catalogue rather than caused by anything a user did.
      expect(EXPORT_SCOPES[name].maxBytes).toBeLessThanOrEqual(
        UPLOAD_PURPOSES.conversation_export.maxBytes,
      );
    },
  );
});

describe('*** SEC-AP2: a contact-bearing scope cannot exist without the mass-export gate ***', () => {
  it('no v1 scope may contain contact data', () => {
    for (const name of EXPORT_SCOPE_NAMES) {
      expect({ name, contact: EXPORT_SCOPES[name].mayContainContactData }).toEqual({
        name,
        contact: false,
      });
    }
  });

  it('the gate this feature pre-wires is the SHARED policy, reachable from any service', () => {
    // Analyze/H4: the throwing wrapper `assertCanMassExport` is users-local, and the export path is in
    // chats — importing it across services would fail the no-cross-service scan (Principle VIII). The
    // POLICY lives in `@crm/common`, which is what a future contact-bearing scope must consult.
    expect(canMassExportContacts('support_agent')).toBe(false);
    expect(canMassExportContacts('vip_support')).toBe(true);
  });

  it('SEC-AP2 is therefore NOT closed by this feature — and that is recorded, not implied', () => {
    // The honest statement of where the finding stands. v1 exports no contact data, so the guard still
    // has no live surface; what exists is a build gate making the gap unforgettable. Closing SEC-AP2
    // on the strength of "we built exports" is the stale-row mistake the findings sweep had to repair
    // in six places.
    const contactScopes = EXPORT_SCOPE_NAMES.filter(
      (n) => EXPORT_SCOPES[n].mayContainContactData,
    );
    expect(contactScopes).toEqual([]);
  });
});

describe('the status and failure vocabularies are closed', () => {
  it('statuses are exactly the five the contract exposes', () => {
    expect([...EXPORT_STATUSES]).toEqual(['queued', 'running', 'ready', 'failed', 'expired']);
  });

  it('terminal states are ready, failed and expired — queued and running are not', () => {
    expect([...TERMINAL_EXPORT_STATUSES]).toEqual(['ready', 'failed', 'expired']);
    expect(TERMINAL_EXPORT_STATUSES).not.toContain('queued');
    expect(TERMINAL_EXPORT_STATUSES).not.toContain('running');
  });

  it('failure reasons are CODES and include authority_revoked (research R15)', () => {
    // Codes, never messages: a raw error string is how a filter term or a row value reaches a place
    // PII must not be (SEC-26). `authority_revoked` is the outcome when the requester's permission is
    // gone by production time — the export fails instead of producing a file on stale authority.
    expect([...EXPORT_FAILURE_REASONS]).toContain('authority_revoked');
    for (const reason of EXPORT_FAILURE_REASONS) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
  });
});
