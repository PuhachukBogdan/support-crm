import 'reflect-metadata';
import { of, throwError } from 'rxjs';
import { PlayerNotesController } from './notes.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';
import {
  MAX_NOTE_BODY_LENGTH,
  outcomeWord,
  parseAddNoteBody,
  parseNotesListQuery,
  toNoteResponse,
} from './wire';
import { MAX_NOTE_LENGTH } from '../../../users/src/player/player-note.service';

/**
 * W35 / feature 040 — the notes EDGE: what it forwards, what it refuses, and what it never says.
 *
 * The service's own tests cover who may read and what the detector finds. This file covers the three
 * things only the edge can get wrong, and each has a live precedent in this repo:
 *   1. **the outcome decode** — proto-loader runs `enums: String`, and treating an unrecognised outcome
 *      as success is how a zero value reads as "stored" (`gotchas/grpc-wire-encoding-enums-longs`, twice);
 *   2. **the refusal's content** — a 403 that leaked a count would answer a question about a customer to
 *      somebody with no clearance for the answer;
 *   3. **the error message** — a body echoed into a 422 puts a note (possibly containing the very contact
 *      value this feature exists to notice) into whatever logs gateway errors (SEC-26).
 */

const CLAIMS = { sub: 'u-1', accountId: 'acc-1', roles: ['am'], permissions: [] } as never;
const effective = () =>
  ({ keys: ['crm.contact.view', 'users.am_notes.edit'], role: 'am', preview: false }) as never;

function harness(answers: {
  list?: unknown;
  add?: unknown;
  listError?: unknown;
  addError?: unknown;
}) {
  const recorded: { args?: Record<string, unknown> } = {};
  const svc = {
    listPlayerNotes: jest.fn((d: Record<string, unknown>) => {
      recorded.args = d;
      if (answers.listError) return throwError(() => answers.listError);
      return of(answers.list ?? { notes: [] });
    }),
    addPlayerNote: jest.fn((d: Record<string, unknown>) => {
      recorded.args = d;
      if (answers.addError) return throwError(() => answers.addError);
      return of(answers.add ?? {});
    }),
  };
  const ctl = new PlayerNotesController({ getService: () => svc } as never);
  ctl.onModuleInit();
  const req = { claims: CLAIMS, effective: effective() } as never;
  return { ctl, svc, req, recorded };
}

const NOTE = {
  id: 'n-1',
  body: 'клиент играет по выходным',
  authorRef: 'auth-am-1',
  authorDisplayName: 'Anna M',
  createdAt: '2026-08-13T10:00:00.000Z',
  patternKinds: [],
};

describe('*** both routes carry a deliberate permission key ***', () => {
  const p = PlayerNotesController.prototype as unknown as Record<string, object>;

  /**
   * ⭐ READING notes rides the card key; WRITING one has its own.
   *
   * ⚠️ The read key is the DOOR and deliberately not the lock: `crm.contact.view` is held by everybody who
   * can open a customer card, and who may actually read the notes is the `am_only` clearance ABOUT THIS
   * PLAYER, decided in the owning service. A narrower key here would hide the surface from people the
   * server is willing to serve — the mistake Q34 corrected for the directory — and a wider LOCK here would
   * move a per-record decision into the tier that cannot see the record.
   *
   * Writing is separate because reading and writing are separate rights: an administrator investigating a
   * customer reads notes without being able to add to the record they are reviewing.
   */
  it('the read is the card key, the write is its own', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.listPlayerNotes!)).toBe('crm.contact.view');
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.addPlayerNote!)).toBe('users.am_notes.edit');
  });

  it('and there is no third route here', () => {
    // The whole surface is two verbs. A route arriving without a key is the 016 wire defect; a route
    // arriving at all is a decision, and it should have to edit this line.
    const routes = Object.getOwnPropertyNames(PlayerNotesController.prototype).filter(
      (n) => n !== 'constructor' && n !== 'onModuleInit' && !n.startsWith('meta'),
    );
    expect(routes.sort()).toEqual(['addPlayerNote', 'listPlayerNotes']);
  });
});

describe('*** the two bounds agree by TEST, not by comment ***', () => {
  it('the edge parse limit equals the service’s note bound', () => {
    // Two numbers in two workspaces that must be the same number. A comment claiming so is not a
    // control — and if they diverged, the edge would refuse a note the service would have accepted, or
    // forward one it will not, and neither failure names itself.
    expect(MAX_NOTE_BODY_LENGTH).toBe(MAX_NOTE_LENGTH);
  });
});

describe('*** GET notes: the brand is required, and a refusal says nothing ***', () => {
  it('forwards the pair and projects each note explicitly', async () => {
    const { ctl, req, recorded } = harness({ list: { notes: [NOTE] } });
    const res = await ctl.listPlayerNotes('ply-1', { brandId: 'brand-a' }, req);
    // `pageSize: 0` = "you decide", which the owning service clamps to its own page.
    expect(recorded.args).toEqual({ playerId: 'ply-1', brandId: 'brand-a', pageSize: 0 });
    expect(res.notes).toEqual([NOTE]);
  });

  it('a missing brandId is a 400 — a platform id alone names two customers', async () => {
    const { ctl, req } = harness({});
    await expect(ctl.listPlayerNotes('ply-1', {}, req)).rejects.toMatchObject({ status: 400 });
  });

  it('an unknown query parameter is refused, not ignored', async () => {
    const { ctl, req } = harness({});
    await expect(
      ctl.listPlayerNotes('ply-1', { brandId: 'brand-a', includeDeleted: 'true' }, req),
    ).rejects.toMatchObject({ status: 400 });
  });

  /**
   * ⭐⭐ **THE DEFECT THE LIVE RUN FOUND, pinned so it cannot come back quietly.**
   *
   * The browser's transport sends `pageSize` on EVERY list read — it comes from the route registry's row,
   * not from a screen — and the first version of this route parsed the query with the card's parser
   * (`brandId` and nothing else). So every notes read in a real browser answered
   * `400 unknown query parameter: pageSize`, while every unit test passed: they call the controller
   * directly, and the live check's API legs hand-build the query without paging.
   *
   * ⓘ Worse, it hid on the screen too: a stored note is prepended from the POST response, so «add a note
   * and watch it appear» passed while the READ was failing the whole time. This test fails on the old code.
   */
  it('⭐ accepts the `pageSize` the browser always sends, and FORWARDS it', async () => {
    const { ctl, req, recorded } = harness({ list: { notes: [NOTE] } });
    const res = await ctl.listPlayerNotes('ply-1', { brandId: 'brand-a', pageSize: '50' }, req);
    expect(res.notes).toEqual([NOTE]);
    // Forwarded, not swallowed: an accepted-and-ignored parameter teaches a client it is advisory.
    expect(recorded.args).toEqual({ playerId: 'ply-1', brandId: 'brand-a', pageSize: 50 });
  });

  it('⛔ refuses `pageToken` — this contract has no paging, and a cursor we ignore is a lie', () => {
    expect(() => parseNotesListQuery({ brandId: 'b', pageToken: 'abc' })).toThrow(/pageToken/);
  });

  it('a nonsense pageSize is a 400, never a silent fallback', () => {
    expect(() => parseNotesListQuery({ brandId: 'b', pageSize: 'all' })).toThrow(/pageSize/);
    expect(() => parseNotesListQuery({ brandId: 'b', pageSize: '0' })).toThrow(/pageSize/);
    // …and absent means "you decide", which the service clamps.
    expect(parseNotesListQuery({ brandId: 'b' })).toEqual({ brandId: 'b', pageSize: 0 });
  });

  it('⭐ a service refusal becomes a bare 403 — no count, no fragment, no upstream sentence', async () => {
    const { ctl, req } = harness({ listError: { code: 7, message: 'forbidden: 3 notes exist' } });
    const err = await ctl.listPlayerNotes('ply-1', { brandId: 'brand-a' }, req).catch((e) => e);
    expect(err.status).toBe(403);
    /**
     * ⚠️ Asserted as an EXACT body rather than as "does not contain 3". The first draft did the latter and
     * failed on the digit inside `403` — a substring check over a response that contains its own status
     * code cannot express "no count leaked". The exact shape can: three fixed keys, a constant message,
     * and nothing that varies with what is stored.
     */
    expect(err.response).toEqual({ message: 'forbidden', error: 'Forbidden', statusCode: 403 });
    expect(JSON.stringify(err.response)).not.toMatch(/notes/i);
  });
});

describe('*** POST notes: the outcome decides the status, and UNKNOWN is never success ***', () => {
  it('stored → the note, and whether it was a replay', async () => {
    const { ctl, req } = harness({
      add: { outcome: 'ADD_NOTE_OUTCOME_STORED', note: NOTE, replayed: true },
    });
    const res = await ctl.addPlayerNote(
      'ply-1',
      { brandId: 'brand-a', body: 'клиент играет по выходным', clientRef: 'ref-1' },
      req,
    );
    expect(res).toEqual({ outcome: 'stored', note: NOTE, replayed: true });
  });

  it('⭐ needs_acknowledgement is a 200 carrying the KINDS — the text is not echoed back as a failure', async () => {
    const { ctl, req } = harness({
      add: { outcome: 'ADD_NOTE_OUTCOME_NEEDS_ACK', patternKinds: ['phone'] },
    });
    const res = await ctl.addPlayerNote(
      'ply-1',
      { brandId: 'brand-a', body: 'звонить на +34 600 123 456', clientRef: 'ref-2' },
      req,
    );
    // A 200, deliberately: the product is answering a question, not refusing. A 4xx would push clients
    // into error handling on the commonest teaching moment — and the text must survive it.
    expect(res).toEqual({ outcome: 'needs_acknowledgement', patternKinds: ['phone'] });
  });

  it('the acknowledgement is forwarded (a dropped flag would loop the author forever)', async () => {
    const { ctl, req, recorded } = harness({ add: { outcome: 'ADD_NOTE_OUTCOME_STORED', note: NOTE } });
    await ctl.addPlayerNote(
      'ply-1',
      { brandId: 'brand-a', body: 'тел +34600123456', acknowledged: true, clientRef: 'ref-3' },
      req,
    );
    expect(recorded.args).toMatchObject({ acknowledged: true, clientRef: 'ref-3' });
  });

  it.each([
    ['ADD_NOTE_OUTCOME_EMPTY_BODY', 422],
    ['ADD_NOTE_OUTCOME_TOO_LONG', 422],
    ['ADD_NOTE_OUTCOME_NO_SUCH_PLAYER', 404],
  ])('%s → %s', async (outcome, status) => {
    const { ctl, req } = harness({ add: { outcome } });
    await expect(
      ctl.addPlayerNote('ply-1', { brandId: 'brand-a', body: 'x', clientRef: 'r' }, req),
    ).rejects.toMatchObject({ status });
  });

  it.each([
    ['the zero value the wire drops', {}],
    ['an unspecified outcome', { outcome: 'ADD_NOTE_OUTCOME_UNSPECIFIED' }],
    ['a word nobody defined', { outcome: 'ADD_NOTE_OUTCOME_MAYBE' }],
  ])('⭐ %s is a 500, NEVER a success', async (_name, add) => {
    const { ctl, req } = harness({ add });
    await expect(
      ctl.addPlayerNote('ply-1', { brandId: 'brand-a', body: 'x', clientRef: 'r' }, req),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('decodes the outcome by NUMBER as well as by name (proto-loader is configured either way)', () => {
    expect(outcomeWord(1)).toBe('stored');
    expect(outcomeWord('ADD_NOTE_OUTCOME_STORED')).toBe('stored');
    expect(outcomeWord(2)).toBe('needs_acknowledgement');
    // …and the failure directions:
    expect(outcomeWord(0)).toBe('');
    expect(outcomeWord(undefined)).toBe('');
    expect(outcomeWord('ADD_NOTE_OUTCOME_UNSPECIFIED')).toBe('');
  });
});

describe('*** the request body is validated where it arrives, and never echoed ***', () => {
  it('requires brandId, a non-blank body, and a clientRef', () => {
    expect(() => parseAddNoteBody({ body: 'x', clientRef: 'r' })).toThrow(/brandId/);
    expect(() => parseAddNoteBody({ brandId: 'b', body: '   ', clientRef: 'r' })).toThrow(/body/);
    expect(() => parseAddNoteBody({ brandId: 'b', body: 'x' })).toThrow(/clientRef/);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(() => parseAddNoteBody({ brandId: 'b', body: 'x', clientRef: 'r', authorRef: 'me' })).toThrow(
      /unknown field/,
    );
  });

  it('⭐ no error message contains any part of the body', () => {
    const secret = 'звонить на +34 600 123 456';
    for (const payload of [
      { brandId: '', body: secret, clientRef: 'r' },
      { brandId: 'b', body: secret },
      { brandId: 'b', body: secret.repeat(400), clientRef: 'r' },
      { brandId: 'b', body: secret, clientRef: 'r', nope: 1 },
    ]) {
      const err = (() => {
        try {
          parseAddNoteBody(payload);
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).not.toBeNull();
      const said = JSON.stringify({ m: err!.message, r: (err as { response?: unknown }).response });
      expect(said).not.toContain('600');
      expect(said).not.toContain('звонить');
    }
  });

  it('keeps `acknowledged` false unless it is exactly true (a string must not acknowledge)', () => {
    expect(parseAddNoteBody({ brandId: 'b', body: 'x', clientRef: 'r' }).acknowledged).toBe(false);
    expect(
      parseAddNoteBody({ brandId: 'b', body: 'x', clientRef: 'r', acknowledged: 'yes' }).acknowledged,
    ).toBe(false);
    expect(
      parseAddNoteBody({ brandId: 'b', body: 'x', clientRef: 'r', acknowledged: true }).acknowledged,
    ).toBe(true);
  });
});

describe('*** the note projection keeps the empties that MEAN something ***', () => {
  it('an unresolved author name stays an empty string, not an absent key', () => {
    // The opposite rule from `toPlayerResponse`, and the difference is the point: there, an absent key
    // hides WHICH field was masked; here, `authorDisplayName: ''` is a real answer ("show the reference")
    // and dropping it would make the screen guess.
    const projected = toNoteResponse({ ...NOTE, authorDisplayName: '' });
    expect('authorDisplayName' in projected).toBe(true);
    expect(projected.authorDisplayName).toBe('');
    expect(projected.patternKinds).toEqual([]);
  });

  it('forwards nothing the message did not declare', () => {
    const projected = toNoteResponse({ ...NOTE, clientRef: 'ref-9', accountId: 'acc-1' });
    expect(Object.keys(projected).sort()).toEqual([
      'authorDisplayName',
      'authorRef',
      'body',
      'createdAt',
      'id',
      'patternKinds',
    ]);
  });
});
