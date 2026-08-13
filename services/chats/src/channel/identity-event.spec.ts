import { Logger } from '@nestjs/common';
import { AUDIT_ACTIONS, parseDetail } from '@crm/common';
import { ChannelIntakeService } from './intake.service';
import { ApiChannelAdapter } from './adapters/api.adapter';
import type { ChannelRow } from './channel.repository';

/**
 * T050/T053/T054/T055 (feature 033, US3) — **what the record of an automatic identity decision says.**
 * FAILS before `resolveIdentity`/`recordIdentity` exist, PASSES after.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **An automatic decision about identity needs a record of itself.** A wrong attachment is otherwise
 * visible only as a customer card that quietly contains someone else's words — and by then an agent has
 * written a note there, which survives any correction (ADR 0044 §5).
 *
 * And the record holds the identifier **CLASS** and never the value (FR-025, ADR 0044 §4). An audited
 * email address would put customer contact data in the one table nothing may delete from.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

const CHANNEL: ChannelRow = {
  id: 'ch-api',
  account_id: 'acc-1',
  brand_id: 'brand-1',
  kind: 'api',
  key: 'api-key',
  address: null,
};

function harness(opts: { playerId?: string; ambiguous?: boolean; identityDown?: boolean } = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const conversations: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const asked: Array<Record<string, unknown>> = [];

  const service = new ChannelIntakeService(
    { secrets: new Map(), replayWindowSeconds: 300 } as never,
    { resolveByKey: async () => CHANNEL } as never,
    {
      claim: async () => ({ fresh: true, intakeId: 'i-1' }),
      recordRefusal: async () => undefined,
      stampProduced: async () => undefined,
      release: async () => undefined,
    } as never,
    new ApiChannelAdapter(),
    {
      create: async (_a: string, input: Record<string, unknown>) => {
        conversations.push(input);
        return { id: 'conv-1' };
      },
    } as never,
    {
      post: async (_a: string, input: Record<string, unknown>) => {
        messages.push(input);
        return { id: 'msg-1' };
      },
    } as never,
    { defaultKeyOfCategory: async () => 'new' } as never,
    { resolve: async () => null } as never,
    {
      resolve: async (input: Record<string, unknown>) => {
        asked.push(input);
        if (opts.identityDown) throw new Error('users unreachable');
        return {
          participantId: '',
          playerId: opts.playerId ?? '',
          ambiguous: opts.ambiguous === true,
        };
      },
    } as never,
    {
      append: async (_a: string, entry: Record<string, unknown>) => {
        audits.push(entry);
      },
    } as never,
  );

  return { service, audits, conversations, messages, asked };
}

/** A widget delivery. Unsigned: the harness's channel has no secret, so verification is skipped. */
const deliver = (service: ChannelIntakeService, payload: Record<string, unknown>) =>
  service.acceptNormalised(CHANNEL, {
    externalEventId: 'evt-1',
    body: 'не могу вывести',
    identity: new ApiChannelAdapter().normalise(payload).ok
      ? (new ApiChannelAdapter().normalise(payload) as { message: { identity?: unknown } }).message
          .identity as never
      : undefined,
  });

describe('the resolution is recorded, with the CLASS and never the value (FR-025)', () => {
  it('records that it happened and which class decided it', async () => {
    const { service, audits } = harness({ playerId: 'pl-7' });
    await deliver(service, { event_id: 'evt-1', text: 'hi', author: { player_id: 'pl-7' } });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'channel.identity_resolved',
      actorKind: 'system',
      targetRef: 'conversation:conv-1',
      detail: { channelKind: 'api', identifierClass: 'player_id' },
    });
    // ⚠️ The action exists in the catalogue and its detail is EXPRESSIBLE. `parseDetail` refuses any key
    // outside the class's allow-list, so this is what makes "the class is recordable and the value is not"
    // a property of the audit layer rather than of this call site's care.
    expect(AUDIT_ACTIONS['channel.identity_resolved']).toBeDefined();
    expect(() => parseDetail('channel.identity_resolved', audits[0]!.detail)).not.toThrow();
  });

  it('refuses to carry the identifier VALUE, even if a future edit tries', async () => {
    // The allow-list is the enforcement. Asserted directly so the guarantee does not rest on every future
    // writer remembering it.
    expect(() =>
      parseDetail('channel.identity_resolved', { identifierValue: 'pl-7' }),
    ).toThrow();
  });

  it('a delivery carrying NO identifier records nothing — there was no resolution', async () => {
    // An entry saying otherwise would be a decision nobody made.
    const { service, audits, asked } = harness();
    await deliver(service, { event_id: 'evt-1', text: 'hi' });
    expect(asked).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe('identity_state is STORED, never derived from a blank (FR-024)', () => {
  it('a resolved player → identified, and the player is on the ticket and the message', async () => {
    const { service, conversations, messages } = harness({ playerId: 'pl-7' });
    await deliver(service, { event_id: 'evt-1', text: 'hi', author: { player_id: 'pl-7' } });
    expect(conversations[0]).toMatchObject({ identityState: 'identified', playerId: 'pl-7' });
    expect(messages[0]).toMatchObject({ authorType: 'player', authorId: 'pl-7' });
  });

  it('an id UNKNOWN to the brand → unidentified, and no player is invented (US1 scenario 6)', async () => {
    const { service, conversations, messages } = harness({ playerId: '' });
    await deliver(service, { event_id: 'evt-1', text: 'hi', author: { player_id: 'nope' } });
    expect(conversations[0]).toMatchObject({ identityState: 'unidentified' });
    expect(conversations[0]!.playerId).toBeUndefined();
    // ⚠️ A NULL author, not a placeholder id and not a generated name. ADR 0044 §1 forbids both, and a
    // stand-in id would be indistinguishable from a real link to whoever later owns that id.
    expect(messages[0]).toMatchObject({ authorId: null });
  });

  it('AMBIGUOUS is treated exactly as nobody — the system does not choose (FR-022)', async () => {
    const { service, conversations } = harness({ playerId: 'pl-1', ambiguous: true });
    await deliver(service, { event_id: 'evt-1', text: 'hi', author: { email: 'a@b.test' } });
    expect(conversations[0]).toMatchObject({ identityState: 'unidentified' });
  });
});

describe('on the API channel, an unreachable identity source does NOT refuse the intake (FR-023)', () => {
  it('the ticket is created unidentified and complete', async () => {
    // ⚠️ The opposite of the MAIL path, and the asymmetry is the point: mail needs the envelope to answer,
    // so accepting without it would create a ticket an agent can read and cannot reply to. The API channel
    // has no reply path at all, so the only thing lost is the link — which W9's manual attach answers.
    const { service, conversations, messages } = harness({ identityDown: true });
    const out = await deliver(service, {
      event_id: 'evt-1',
      text: 'не могу вывести',
      author: { player_id: 'pl-7' },
    });
    expect(out.refusal).toBeUndefined();
    expect(conversations[0]).toMatchObject({ identityState: 'unidentified' });
    expect(messages[0]).toMatchObject({ body: 'не могу вывести' });
  });

  it('and the failure names the CLASS, never the identifier', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      }),
    );
    try {
      const { service } = harness({ identityDown: true });
      await deliver(service, {
        event_id: 'evt-1',
        text: 'hi',
        author: { email: 'player@mail.test' },
      });
      // Asserted FIRST: a scan over an empty array reports success, which is the vacuous pass this
      // project has shipped three times.
      expect(lines.length).toBeGreaterThan(0);
      const all = lines.join('\n');
      expect(all).toContain('class=email');
      expect(all.toLowerCase()).not.toContain('player@mail.test');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
