import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clientAddressFrom } from '@crm/common';
import { of } from 'rxjs';
import type { Response } from 'express';
import { ProvisioningController } from './provisioning.controller';

/**
 * ⭐ W31 / feature 038 — the machine edge forwards, and forwards FAITHFULLY.
 *
 * Every property tested here is one where being *nearly* right produces a failure that points at the
 * wrong party: a re-serialised body makes the caller's signing look broken, a joined header makes
 * their key look wrong, and the first entry of a forwarded chain makes an attacker's claim about
 * their own address look like the truth. None of them would show up as an error on our side.
 */

type Wire = Record<string, unknown>;

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

function harness(answer: Wire = { statusCode: 202, problemType: '', outcome: 'invited', bodyJson: '{"outcome":"invited"}' }) {
  const sent: Wire[] = [];
  const client = {
    getService: () => ({
      provisionStaff: (d: Wire) => {
        sent.push(d);
        return of(answer);
      },
      deactivateStaff: (d: Wire) => {
        sent.push(d);
        return of(answer);
      },
    }),
  };
  const ctrl = new ProvisioningController(client as never);
  ctrl.onModuleInit();
  const res = { status: jest.fn(), type: jest.fn() } as unknown as Response;
  return { ctrl, sent, res };
}

const req = (over: Record<string, unknown> = {}) =>
  ({
    headers: {
      'x-crm-key': 'key-1.secret-half.with.dots',
      'x-crm-signature': 't=1760000000,v1=abc',
      'idempotency-key': 'idem-1',
      'x-forwarded-for': '198.51.100.9, 203.0.113.7',
      ...((over.headers as object) ?? {}),
    },
    socket: { remoteAddress: '10.0.0.1' },
    rawBody: Buffer.from('{"hrEmployeeId": "E-1"}', 'utf8'),
    ...over,
  }) as never;

describe('*** the bytes that were signed are the bytes that travel ***', () => {
  it('forwards `rawBody` verbatim — spacing and key order intact', async () => {
    const { ctrl, sent, res } = harness();
    await ctrl.createStaff(req(), res);
    // ⚠️ Note the space after the colon. `JSON.stringify(JSON.parse(x))` would remove it, and the
    // signature is over the ORIGINAL bytes — so every call would be refused and the symptom would
    // read as «the provider signs wrongly», the hardest kind of fault to attribute.
    expect(sent[0]!.rawBody).toBe('{"hrEmployeeId": "E-1"}');
  });

  it('an absent body forwards as an empty string, not as undefined', async () => {
    const { ctrl, sent, res } = harness();
    await ctrl.offboardStaff('E-1', req({ rawBody: undefined }), res);
    // A DELETE carries no body and is still signed — the timestamp is what the signature protects
    // there. `undefined` would serialise to a missing proto field and change what auth digests.
    expect(sent[0]!.rawBody).toBe('');
    expect(sent[0]!.hrEmployeeId).toBe('E-1');
  });
});

describe('the credential is split, never parsed', () => {
  it('splits `<id>.<secret>` on the FIRST dot, so a secret may contain dots', async () => {
    const { ctrl, sent, res } = harness();
    await ctrl.createStaff(req(), res);
    expect(sent[0]!.keyId).toBe('key-1');
    expect(sent[0]!.keySecret).toBe('secret-half.with.dots');
  });

  it.each([['no dot at all', 'key-1'], ['nothing before the dot', '.secret'], ['nothing after it', 'key-1.']])(
    'a malformed key (%s) forwards as EMPTY halves rather than a guess',
    async (_name, header) => {
      const { ctrl, sent, res } = harness();
      await ctrl.createStaff(req({ headers: { 'x-crm-key': header } }), res);
      // Refusing here would be this edge deciding something. It forwards two empty strings and auth
      // answers `unknown_key` — the same answer an invented id gets, which is the point (§5).
      expect({ id: sent[0]!.keyId, secret: sent[0]!.keySecret }).toEqual({ id: '', secret: '' });
    },
  );

  it('*** a REPEATED header is not concatenated — it forwards as absent ***', async () => {
    const { ctrl, sent, res } = harness();
    await ctrl.createStaff(req({ headers: { 'x-crm-signature': ['t=1,v1=a', 't=2,v1=b'] } }), res);
    // Express joins repeated headers into an array. Joining them into one string would let a caller
    // smuggle a second signature past a check that only ever reads one.
    expect(sent[0]!.signatureHeader).toBe('');
  });
});

describe('*** ⭐ the caller cannot choose the address they are judged by ***', () => {
  it('takes the LAST forwarded entry — the one our own proxy appended', async () => {
    const { ctrl, sent, res } = harness();
    await ctrl.createStaff(req(), res);
    // The header reads `198.51.100.9, 203.0.113.7`. The first entry is whatever the client SENT —
    // it can say anything. The last was written by our edge from the socket it accepted, so an
    // attacker prefixing an allow-listed address to their own request gains nothing.
    expect(sent[0]!.clientIp).toBe('203.0.113.7');
    expect(clientAddressFrom('198.51.100.9, 203.0.113.7', '10.0.0.1')).toBe('203.0.113.7');
  });

  it('falls back to the socket address when nothing was forwarded', async () => {
    const { ctrl, sent, res } = harness();
    await ctrl.createStaff(req({ headers: { 'x-forwarded-for': undefined } }), res);
    expect(sent[0]!.clientIp).toBe('10.0.0.1');
  });
});

describe('the answer is rendered, never re-decided', () => {
  it('a refusal keeps its status AND is typed problem+json', async () => {
    const { ctrl, res } = harness({
      statusCode: 401,
      problemType: 'unauthorized',
      outcome: 'refused',
      bodyJson: '{"type":"https://crm.local/problems/unauthorized","status":401}',
    });
    const body = await ctrl.createStaff(req(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.type).toHaveBeenCalledWith('application/problem+json');
    expect(body).toEqual({ type: 'https://crm.local/problems/unauthorized', status: 401 });
  });

  it('a success is ordinary json', async () => {
    const { ctrl, res } = harness();
    const body = await ctrl.createStaff(req(), res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.type).toHaveBeenCalledWith('application/json');
    expect(body).toEqual({ outcome: 'invited' });
  });

  it('*** an unreadable answer becomes 500, never a 200 with an empty body ***', async () => {
    const { ctrl, res } = harness({ statusCode: 0, problemType: '', outcome: '', bodyJson: 'not json' });
    const body = await ctrl.createStaff(req(), res);
    // A missing status means auth answered something this edge does not understand. Rendering that
    // as success would tell an HR platform a colleague was hired when nobody knows what happened.
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body).toEqual({});
  });
});

describe('*** ⭐ no route re-declares the `/api` prefix the rewrite already strips ***', () => {
  it('every @Controller path in the gateway is prefix-free', () => {
    /**
     * The browser calls `/api/…`; `web/next.config` rewrites it to the gateway WITHOUT the prefix
     * (feature 019 — the gateway's origin is never exposed to a browser). So a controller written as
     * `api/provisioning/v1` answers at `/api/api/provisioning/v1` and the real path 404s.
     *
     * ⚠️ Not hypothetical, and not new: feature 026's live run found `@Controller('api')` on the
     * presence and assignment edges and corrected both (their headers still tell the story), and W31
     * reintroduced the same mistake in a new shape — because the correction left no test behind.
     * This is that missing memory. Nothing in a unit test crosses the rewrite, so reading the paths
     * is the only cheap way to hold the rule; scanned rather than listed, so it covers the
     * controller somebody adds next.
     *
     * ⓘ Comments are stripped first. The first version matched the words `@Controller('api')` inside
     * the two docblocks EXPLAINING the old defect — a guard held hostage by prose about itself.
     */
    const src = resolve(__dirname, '..');
    const files = walkTs(src);
    const paths = files.flatMap((f) => {
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return [...code.matchAll(/@Controller\(\s*'([^']*)'/g)].map((m) => m[1]!);
    });
    expect(paths.length).toBeGreaterThan(8); // anti-vacuum: the scan found the controllers.
    expect(paths.filter((p) => /^\/?api(\/|$)/.test(p))).toEqual([]);
  });
});

describe('*** ⭐ this edge orchestrates NOTHING ***', () => {
  it('holds one client only — there is no seam to assemble here', () => {
    // The handover used to be called from this file. It is a maintenance rpc, and
    // `tests/worker/maintenance-ticks.spec.ts` refuses to let the gateway name one. Expressed here as
    // the constructor's own shape: a second client is what re-growing that seam would look like.
    expect(ProvisioningController.length).toBe(1);
  });
});
