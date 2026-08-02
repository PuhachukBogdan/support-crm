import { OutboundEmailService } from './outbound-email.service';
import { MailSendError, type MailTransport } from './mail-transport';
import type { AuthConfig } from '../../config';

/**
 * T028 (feature 028) — the state machine. FAILS before the service exists, PASSES after.
 *
 * Every case here is a way a message is lost in production, not a way a function is wrong.
 */

interface Row {
  id: string;
  account_id: string;
  to_email: string;
  purpose: string;
  payload_json: Record<string, unknown>;
  expires_at: Date;
  status: string;
  attempts: number;
  last_error_class: string | null;
  last_attempt_at: Date | null;
  created_at: Date;
}

const NOW = new Date('2026-08-02T12:00:00Z');
const clock = { now: () => NOW };

function cfg(over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    MAIL_BRAND_NAME: 'Support CRM',
    APP_BASE_URL: 'https://crm.example.test',
    MAIL_MAX_ATTEMPTS: 3,
    ...over,
  } as unknown as AuthConfig;
}

/** A tiny in-memory stand-in for the one table this service touches. */
function fakePrisma(rows: Row[]) {
  return {
    rows,
    outboundEmail: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row = {
          id: `row-${rows.length + 1}`,
          status: 'pending',
          attempts: 0,
          last_error_class: null,
          last_attempt_at: null,
          created_at: NOW,
          ...data,
        } as Row;
        rows.push(row);
        return { id: row.id };
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const w = where as { id?: string; status?: string; last_attempt_at?: { lt: Date } };
        const matched = rows.filter((r) => {
          if (w.id && r.id !== w.id) return false;
          if (w.status && r.status !== w.status) return false;
          if (w.last_attempt_at?.lt) {
            if (!r.last_attempt_at || r.last_attempt_at >= w.last_attempt_at.lt) return false;
          }
          return true;
        });
        matched.forEach((r) => Object.assign(r, data));
        return { count: matched.length };
      },
      async findUnique({ where }: { where: { id: string } }) {
        return rows.find((r) => r.id === where.id) ?? null;
      },
      async findFirst({ where }: { where: { status: string } }) {
        return rows.find((r) => r.status === where.status) ?? null;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      async delete({ where }: { where: { id: string } }) {
        const i = rows.findIndex((r) => r.id === where.id);
        return rows.splice(i, 1)[0];
      },
    },
  };
}

function pendingRow(over: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    account_id: 'acc-1',
    to_email: 'agent@example.test',
    purpose: 'login_code',
    payload_json: { code: 'RFDV8T' },
    expires_at: new Date(NOW.getTime() + 10 * 60_000),
    status: 'pending',
    attempts: 0,
    last_error_class: null,
    last_attempt_at: null,
    created_at: NOW,
    ...over,
  };
}

function make(rows: Row[], transport: MailTransport, config = cfg()) {
  const prisma = fakePrisma(rows);
  const service = new OutboundEmailService(
    prisma as never,
    config,
    transport,
    clock as never,
  );
  return { service, prisma };
}

const accepting: MailTransport = { send: async () => undefined };

describe('the happy path', () => {
  it('⭐ deletes the row once a transport accepted it', async () => {
    // Kept rows would build, in the clear, a log of who signed in and when — in a table that also
    // holds live codes. The outbox is a queue, not an archive.
    const rows = [pendingRow()];
    const { service } = make(rows, accepting);

    await service.attemptOne('row-1');

    expect(rows).toHaveLength(0);
  });

  it('renders through the same path the message will really take', async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const rows = [pendingRow()];
    const { service } = make(rows, { send: async (m) => void sent.push(m) });

    await service.attemptOne('row-1');

    expect(sent[0]!.to).toBe('agent@example.test');
    expect(sent[0]!.subject).toContain('RFDV8T');
  });
});

describe('claiming', () => {
  it('⭐ two claimers race and exactly one wins', async () => {
    // `pending → sending` is a conditional update. Without it, an immediate attempt racing the
    // sweep sends the same code twice and the person cannot tell which is live.
    const rows = [pendingRow()];
    const seen: string[] = [];
    const { service } = make(rows, { send: async (m) => void seen.push(m.subject) });

    await Promise.all([service.attemptOne('row-1'), service.attemptOne('row-1')]);

    expect(seen).toHaveLength(1);
  });

  it('does not touch a row somebody else already claimed', async () => {
    const rows = [pendingRow({ status: 'sending' })];
    const send = jest.fn();
    const { service } = make(rows, { send });

    await service.attemptOne('row-1');

    expect(send).not.toHaveBeenCalled();
  });

  it('⚠️ reclaims a claim whose owner died', async () => {
    // Without this, a crash loses exactly the messages that were in flight — the ones somebody is
    // actively waiting for.
    const rows = [
      pendingRow({ status: 'sending', last_attempt_at: new Date(NOW.getTime() - 300_000) }),
    ];
    const { service } = make(rows, accepting);

    const result = await service.sendDue(5);

    expect(result.sent).toBe(1);
    expect(rows).toHaveLength(0);
  });
});

describe('failures', () => {
  it('a temporary fault goes back to pending, with the attempt counted', async () => {
    const rows = [pendingRow()];
    const { service } = make(rows, {
      send: async () => {
        throw new MailSendError('unreachable');
      },
    });

    await service.attemptOne('row-1');

    expect(rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error_class: 'unreachable',
    });
  });

  it('stops retrying at the ceiling', async () => {
    const rows = [pendingRow({ attempts: 2 })]; // MAIL_MAX_ATTEMPTS = 3
    const { service } = make(rows, {
      send: async () => {
        throw new MailSendError('unreachable');
      },
    });

    await service.attemptOne('row-1');

    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('a permanent refusal is not retried at all', async () => {
    const rows = [pendingRow()];
    const { service } = make(rows, {
      send: async () => {
        throw new MailSendError('refused');
      },
    });

    await service.attemptOne('row-1');

    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1, last_error_class: 'refused' });
  });

  it('a blocked recipient is permanent and keeps its own class', async () => {
    const rows = [pendingRow({ to_email: 'stranger@elsewhere.test' })];
    const { service } = make(rows, {
      send: async () => {
        throw new MailSendError('recipient_blocked');
      },
    });

    await service.attemptOne('row-1');

    expect(rows[0]).toMatchObject({ status: 'failed', last_error_class: 'recipient_blocked' });
  });

  it('⭐ abandons a message whose contents have already expired', async () => {
    // Sending it would be worse than not: the person types a correct-looking code and is told it
    // is wrong.
    const rows = [pendingRow({ expires_at: new Date(NOW.getTime() - 1_000) })];
    const send = jest.fn();
    const { service } = make(rows, { send });

    await service.attemptOne('row-1');

    expect(send).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'failed', last_error_class: 'expired' });
  });

  it('never throws — the caller is not waiting and has nowhere to put an exception', async () => {
    const rows = [pendingRow()];
    const { service } = make(rows, {
      send: async () => {
        throw new Error('something entirely unexpected');
      },
    });

    await expect(service.attemptOne('row-1')).resolves.toBeUndefined();
    expect(rows[0]!.status).toBe('pending'); // unknown ⇒ retryable
  });
});

describe('what is written down', () => {
  it('⚠️ the failure record carries a CLASS and no message content', async () => {
    const rows = [pendingRow()];
    const { service } = make(rows, {
      send: async () => {
        throw new MailSendError('refused');
      },
    });

    await service.attemptOne('row-1');

    const serialised = JSON.stringify({
      class: rows[0]!.last_error_class,
      status: rows[0]!.status,
      attempts: rows[0]!.attempts,
    });
    expect(serialised).not.toContain('RFDV8T');
    expect(rows[0]!.last_error_class).toBe('refused');
  });
});

describe('enqueue', () => {
  it('writes the row through the transaction client it is handed', async () => {
    // The signature is the guarantee: this can only be called with a transaction, so the row and
    // the code it announces are written together or not at all.
    const rows: Row[] = [];
    const { service, prisma } = make(rows, accepting);

    const id = await service.enqueue(prisma as never, {
      accountId: 'acc-1',
      to: 'agent@example.test',
      purpose: 'login_code',
      payload: { code: 'RFDV8T' },
      expiresAt: new Date(NOW.getTime() + 600_000),
    });

    expect(id).toBe('row-1');
    expect(rows[0]).toMatchObject({ status: 'pending', purpose: 'login_code', attempts: 0 });
  });
});
