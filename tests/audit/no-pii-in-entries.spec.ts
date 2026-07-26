import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { AuditDetailError, parseDetail } from '@crm/common';

/**
 * T048 (feature 015) — **no PII reaches an audit entry or an audit log line.** SC-007 / SC-010.
 *
 * These are the rows that *describe* PII access. A leak here would file the protected value right next to the
 * record of who wanted it — the worst possible place for it, and the one place a reviewer is guaranteed to
 * look. So the guard is doubled: the allow-list makes PII inexpressible in a detail (asserted below against
 * realistic values), and a source scan asserts no audit code path logs a fact, a body or an identifier.
 */
const ROOT = resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const auditSources = (['auth', 'users', 'chats', 'gateway'] as const).flatMap((s) => {
  const dir = join(ROOT, 'services', s, 'src');
  return walk(dir).filter((f) => f.split(sep).join('/').includes('/audit/'));
});

const LOG_CALL = /(console\.\w+|logInfo|logError|logWarn|logDebug|logger\.(log|warn|error|debug|verbose))\s*\(/;
const SENSITIVE =
  /\b(body|messageText|facts|email|phone|detail_json|detailJson|target_ref|targetRef|actor_user_id|actorUserId)\b/;

describe('the audit code logs nothing sensitive', () => {
  it('finds the audit sources it is meant to police', () => {
    expect(auditSources.length).toBeGreaterThanOrEqual(6);
  });

  it('no audit source logs an entry field', () => {
    const offenders: string[] = [];
    for (const file of auditSources) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (LOG_CALL.test(line) && SENSITIVE.test(line)) {
            offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('a detail cannot express PII, whatever key it arrives under', () => {
  // Realistic values, on keys that are LEGITIMATE for their class — which is the case a key-only allow-list
  // would miss entirely.
  it.each([
    ['automation.delete', 'name', 'player.smith@example.test'],
    ['automation.delete', 'name', '+44 7700 900123'],
    ['permission.grant', 'permissionKey', 'someone@example.test'],
    ['contact.reveal', 'tier', 'phone: +34 600 123 456'],
  ])('%s / %s refuses %p', (action, key, value) => {
    expect(() => parseDetail(action as never, { [key]: value })).toThrow(AuditDetailError);
  });

  it('refuses a card number written inside a sentence', () => {
    expect(() =>
      parseDetail('automation.delete', {
        name: 'card ending 4111 1111 1111 1111 please call back',
      }),
    ).toThrow(AuditDetailError);
  });

  it('refuses anything long enough to be prose rather than a name', () => {
    expect(() => parseDetail('automation.delete', { name: 'x'.repeat(121) })).toThrow(AuditDetailError);
  });

  /**
   * What these checks do NOT promise, stated so nobody mistakes the guard for more than it is: a SHORT
   * free-text sentence with no email, phone or card in it is indistinguishable from an operator-authored rule
   * name, and no string check can separate them. What keeps that safe is upstream — the only key that accepts
   * free text (`name`) is populated by the product from `Automation.name`, which is configuration an operator
   * typed, never a customer-supplied field. The value checks are the second line, not the only one.
   */
  it('does not pretend to detect prose that contains no structured PII', () => {
    expect(parseDetail('automation.delete', { name: 'Route deposits to team two' })).toEqual({
      name: 'Route deposits to team two',
    });
  });

  it('still accepts the legitimate values every writer actually uses', () => {
    expect(parseDetail('permission.grant', { scope: 'user', permissionKey: 'crm.labels.manage', grant: true })).toBeDefined();
    expect(parseDetail('automation.delete', { name: 'seed-keyword-triage', revision: 2 })).toBeDefined();
    expect(parseDetail('contact.reveal', { tier: 'masked_pii' })).toBeDefined();
    expect(parseDetail('audit.read', { filters: ['actorUserId', 'targetRef'] })).toBeDefined();
  });
});
