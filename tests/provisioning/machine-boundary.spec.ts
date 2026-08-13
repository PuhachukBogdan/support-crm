import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isAddressAllowed } from '../../libs/common/src/net/ip-allow-list';

/**
 * ⭐ W31 / feature 038 (ADR 0043 §2/§4/§5, SEC-PV1) — **the three properties of the machine boundary
 * that must hold STRUCTURALLY**, because each of them is the kind of protection a later change can
 * dissolve without breaking a single behavioural test.
 *
 * The HR platform holds a shared secret and can create and close staff accounts with it. It is not a
 * person, it has no session, and it cannot be asked to think. Everything that limits it therefore has
 * to be true of the SHAPE of the code, not of the order some check happens to run in:
 *
 *   1. the machine's invitation path has **no role parameter at all** — least privilege as a missing
 *      argument rather than a validated one (SEC-PV1);
 *   2. the three machine-facing service rpcs are **unnameable from the gateway** — no HTTP route can
 *      exist for them, so their system-actor gate is the only door and not merely the first one;
 *   3. the address allow-list is **fail-closed**, and stays the opposite of the mail guard next to it.
 *
 * All three are text scans with comments stripped. A comment saying «we never do X» is exactly what a
 * file looks like the day it starts doing X.
 */
const ROOT = resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

function codeOf(...segments: string[]): string {
  return readFileSync(join(ROOT, ...segments), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const INVITE_SERVICE = 'services/auth/src/auth/invite.service.ts';
const inviteCode = codeOf(...INVITE_SERVICE.split('/'));

/** The method's own text: from its signature to the closing brace at method indentation. */
function methodBody(code: string, name: string): string {
  const start = code.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = code.slice(start);
  const end = rest.indexOf('\n  }');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

function paramsOf(code: string, name: string): string[] {
  const sig = new RegExp(`async ${name}\\(([\\s\\S]*?)\\)\\s*:`).exec(code);
  expect(sig).not.toBeNull();
  return sig![1]!
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

describe('*** the machine invitation path has NO role parameter — least privilege as an absence ***', () => {
  /**
   * SEC-PV1 asks for a least-privilege bar that is structural rather than «a check that could be
   * reordered away», and this is what that means in code. The human path authorises by comparing the
   * INVITER's roles (`canInvite`); a machine holding a shared secret has no roles, so that protection
   * does not transfer. The tempting repair is to let the caller pass the role and validate it — at
   * which point the strongest account in the product is one field in a request body from a system we
   * do not run, protected by whichever validation is written correctly today.
   *
   * With no parameter there is nothing to smuggle `admin` through, no default to override and no
   * ordering to get wrong. That is why the test asserts the *signature*, which is the property, rather
   * than «a request naming admin is refused», which is the symptom of the property being present.
   */
  it('takes an account, an email and the machine’s own reference — and nothing that names a role', () => {
    const params = paramsOf(inviteCode, 'createProvisioningInvitation');
    expect(params).toHaveLength(3);
    expect(params.filter((p) => /role/i.test(p))).toEqual([]);
  });

  it('the role it mints comes from a MODULE constant, not from anything the caller supplied', () => {
    const body = methodBody(inviteCode, 'createProvisioningInvitation');
    // Both the catalogue lookup and the row it writes read the same constant. If either took a
    // variable, the constant would be decoration on one line and a hole on the other.
    expect(body).toContain('key: PROVISIONING_ROLE');
    expect(body).toContain('role_key: PROVISIONING_ROLE');
    // …and nothing role-shaped is read out of the arguments inside the body.
    expect(body).not.toMatch(/\broleKey\b/);

    // The constant is declared once, at module scope — a per-call `const` could be computed from an
    // argument and would still satisfy the two assertions above.
    const declaration = /^const PROVISIONING_ROLE = '[a-z_]+';$/m.exec(inviteCode);
    expect(declaration).not.toBeNull();
    expect(inviteCode.indexOf(declaration![0])).toBeLessThan(inviteCode.indexOf('class InviteService'));
  });

  it('the HUMAN path still takes a role — the asymmetry is the design, not an oversight', () => {
    // Anti-vacuum with a purpose: it proves the scan can see a role parameter when one is there, and
    // it pins the contrast. A future «tidy-up» that unified the two methods would fail here first.
    expect(paramsOf(inviteCode, 'createInvitation').some((p) => /role/i.test(p))).toBe(true);
  });
});

describe('*** no gateway file can even NAME the three machine service rpcs ***', () => {
  /**
   * ⚠️ **Deliberately the second lock on the same door, and stated as such rather than as a copy.**
   * `tests/worker/maintenance-ticks.spec.ts` already forbids the gateway from naming any maintenance
   * rpc — derived from the PROTO tree, so it protects the whole surface generically and would notice
   * a rename. This one is pinned by literal name from the PROVISIONING side, and it earns its place
   * for two reasons that guard differently:
   *
   *   • it survives the other guard's own weakening. That check reads whatever `*MaintenanceService`
   *     currently declares; move one of these three rpcs to a service with another name and it stops
   *     being examined at all, silently, while this file keeps failing.
   *   • it names the three that MATTER HERE. These are the calls that close an account and empty a
   *     colleague's queue. Their gate is the actor KIND — `x-actor-kind: system` — which no breadth
   *     of a human's permissions can satisfy; the instant an HTTP route can reach one, that gate is
   *     decoration and a session becomes a way to strip a colleague of their work.
   *
   * The gateway is also where this nearly went: the first draft of the offboarding orchestrated all
   * three inside its own `DELETE` handler.
   */
  const MACHINE_RPCS = ['ReturnOperatorWorkToBacklog', 'SetOperatorActive', 'ListDisabledStaff'];
  const GATEWAY = walk(join(ROOT, 'services', 'gateway', 'src')).map((f) => ({
    file: rel(f),
    code: codeOf(...rel(f).split('/')),
  }));

  it('the scan sees the gateway (guards against a vacuous pass)', () => {
    expect(GATEWAY.length).toBeGreaterThan(20);
    expect(GATEWAY.map((f) => f.file)).toContain(
      'services/gateway/src/provisioning/provisioning.controller.ts',
    );
    // Not just the file LIST: the scan must be reading code, or «no file names the rpc» is true of an
    // empty string. The gateway does reach auth for provisioning — through the ordinary `AuthService`,
    // which is the whole point: the door it may not open is a different one.
    expect(GATEWAY.some((f) => f.code.includes("getService<AuthProvisioningGrpc>('AuthService')"))).toBe(
      true,
    );
  });

  it('the same predicate FINDS all three in the worker, which is where they belong', () => {
    // The positive control. It proves the search works — and it states the invariant's other half:
    // these three rpcs have exactly one caller in the product, and it is a tick with no session
    // behind it (`services/worker/src/jobs/staff-offboarding.job.ts`).
    const worker = walk(join(ROOT, 'services', 'worker', 'src')).map((f) => codeOf(...rel(f).split('/')));
    for (const rpc of MACHINE_RPCS) {
      const camel = rpc.charAt(0).toLowerCase() + rpc.slice(1);
      expect({ rpc, found: worker.some((c) => c.includes(camel)) }).toEqual({ rpc, found: true });
    }
  });

  it.each(MACHINE_RPCS)('%s appears in no gateway source, in either casing', (rpc) => {
    const camel = rpc.charAt(0).toLowerCase() + rpc.slice(1);
    const offenders = GATEWAY.filter((f) => f.code.includes(rpc) || f.code.includes(camel)).map(
      (f) => f.file,
    );
    expect({ rpc, offenders }).toEqual({ rpc, offenders: [] });
  });
});

describe('*** the address allow-list is FAIL-CLOSED, and stays the opposite of the mail guard ***', () => {
  it('an empty list allows nobody', () => {
    // The behaviour, at the boundary that matters: a key whose addresses were never configured is a
    // key nobody decided to trust, and the safe reading of an absent decision is refusal. Unit-level
    // coverage lives in `libs/common/src/net/ip-allow-list.spec.ts`; what is pinned HERE is that the
    // provisioning surface depends on this direction of the default.
    expect(isAddressAllowed('203.0.113.7', [])).toBe(false);
    // «We could not tell who called» is not a reason to proceed on a surface that creates accounts.
    expect(isAddressAllowed(undefined, ['203.0.113.7'])).toBe(false);
    expect(isAddressAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
  });

  it('the credential path actually CONSULTS it before accepting a call', () => {
    // A fail-closed helper nobody calls is a fail-open boundary.
    const verify = codeOf('services', 'auth', 'src', 'provisioning', 'provisioning.verify.ts');
    expect(verify).toMatch(/isAddressAllowed\(/);
  });

  it('the MAIL guard keeps the opposite default, so the inconsistency cannot be «fixed» into one', () => {
    /**
     * `libs/common/src/mail/guards.ts` treats an empty list as «no restriction», and that is correct
     * for its own boundary: its list narrows an egress that is otherwise legitimate, and an operator
     * who configured nothing still expects mail to leave. The address list guards an INBOUND
     * credential that can mint and disable staff accounts, so empty must mean «nobody».
     *
     * Both are right; the danger is a tidy-minded reader who notices two helpers disagreeing and
     * aligns them. Aligning them toward the mail default turns every unconfigured key into a
     * globally-callable one. This assertion makes that edit fail loudly in a file that explains why.
     */
    const mail = codeOf('libs', 'common', 'src', 'mail', 'guards.ts');
    expect(mail).toContain('if (allowedDomains.length === 0) return true;');
    const net = codeOf('libs', 'common', 'src', 'net', 'ip-allow-list.ts');
    expect(net).toContain('if (allowList.length === 0) return false;');
    // Two helpers, two files: one shared helper serving both boundaries is the shape that cannot hold
    // two defaults at once.
    expect(mail).not.toContain('isAddressAllowed');
  });
});
