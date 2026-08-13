import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { SecurityPosture } from './security-posture';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';
import type { SecurityFactWire } from './types';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.11) — the security-posture page.
 *
 * This is the one screen in the product where being WRONG is worse than being absent, so the tests
 * are shaped around the two ways it could be wrong while looking perfect:
 *
 * 1. **A `built_in` fact must read as «built into the product», never as a setting that is switched
 *    on** (FR-017, US3 scenario 2). A row somebody typed and a row that was read are identical to the
 *    eye; the origin has to be on the screen, and there must be no toggle anywhere near it.
 * 2. **`unknown` must never look like `ok`** (FR-020). An unreachable service reading as a passing
 *    check is the false assurance the page exists to prevent — so the badge, the tone and the summary
 *    all have to say «not checked», and the summary must lead with it.
 * 3. Severity ORDER: what needs acting on is above what is merely context (FR-021).
 * 4. The screen knows no fact keys (FR-023): a fact this build has never heard of renders anyway —
 *    including one whose SEVERITY is a word this build does not know, which is shown first and
 *    unclassified rather than dropped or filed under «informational».
 * 5. Loading ≠ empty ≠ error ≠ ready, and «no facts» is explicitly NOT a clean result.
 * 6. Without `platform.settings.manage`: the refusal in words, and not one request.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

/** Deliberately shuffled: informational first, critical last, an unknown severity in the middle. */
const FACTS: SecurityFactWire[] = [
  {
    key: 'auth.api_keys.empty_list_denies_all',
    label: 'Пустой список адресов у ключа',
    severity: 'informational',
    kind: 'built_in',
    // ⚠️ The wire sends `ok` for a built-in — a formality of proto3, not a check that ran.
    state: 'ok',
    value: 'пустой список адресов запрещает всё',
    note: 'Свойство продукта, а не настройка: переключателя для этого нет.',
  },
  {
    key: 'made.up.by.a.newer.service',
    label: 'Что-то, о чём эта сборка не знает',
    severity: 'advisory',
    kind: 'read',
    state: 'ok',
    value: '7',
  },
  {
    key: 'auth.api_keys.without_addresses',
    label: 'Ключи без списка адресов',
    severity: 'recommended',
    kind: 'read',
    state: 'attention',
    value: '2',
    note: 'Такой ключ не пройдёт ни один запрос.',
  },
  {
    key: 'chats.unavailable',
    label: 'Не удалось прочитать состояние: chats',
    severity: 'critical',
    kind: 'read',
    state: 'unknown',
    value: 'неизвестно',
    note: 'Служба не ответила.',
  },
  {
    key: 'auth.login.fixed_code',
    label: 'Фиксированный код входа',
    severity: 'critical',
    kind: 'read',
    state: 'attention',
    value: 'включён для 3 аккаунтов',
  },
];

interface Stub extends DataAccess {
  reads: ResourceName[];
}

function stub(opts: { facts?: SecurityFactWire[]; failGets?: number } = {}): Stub {
  let getsLeftToFail = opts.failGets ?? 0;
  const s: Stub = {
    reads: [],
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      s.reads.push(resource);
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(resource: ResourceName): Promise<T> {
      s.reads.push(resource);
      if (resource === 'admin-security') {
        if (getsLeftToFail > 0) {
          getsLeftToFail -= 1;
          throw { message: 'boom', retryable: true };
        }
        return {
          facts: opts.facts ?? FACTS,
          generatedAt: '2026-08-13T04:05:06.000Z',
        } as T;
      }
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('this screen writes nothing');
    },
    async update<T = unknown>(): Promise<T> {
      throw new Error('this screen writes nothing');
    },
    async remove<T = void>(): Promise<T> {
      throw new Error('this screen writes nothing');
    },
    subscribe(): () => void {
      return () => {};
    },
  };
  return s;
}

const seed = (keys: string[]) =>
  ({ kind: 'authenticated', userId: 'u1', accountId: 'a1', roles: [], permissionKeys: keys }) as const;

function renderScreen(s: Stub, keys: string[] = ['platform.settings.manage']) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()} sessionSeed={seed(keys) as never}>
      <SecurityPosture />
    </Providers>,
  );
}

const rowKeys = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid^="fact-row-"]')].map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('fact-row-', ''),
  );

afterEach(() => setDataAccess(new MockDataAccess()));

describe('the four states are four different renderings', () => {
  it('loading → ready: every fact, its value, its note and when the page was read', async () => {
    const s = renderScreen(stub());

    expect(s.container.querySelector('[aria-busy]')).not.toBeNull();

    await screen.findByTestId('fact-row-auth.login.fixed_code');
    expect(screen.getByTestId('fact-value-auth.login.fixed_code')).toHaveTextContent(
      'включён для 3 аккаунтов',
    );
    expect(screen.getByTestId('fact-row-auth.api_keys.without_addresses')).toHaveTextContent(
      'Такой ключ не пройдёт ни один запрос.',
    );
    // The read is a timestamped claim, and the timestamp is stated in UTC rather than guessed local.
    expect(screen.getByTestId('security-generated-at')).toHaveTextContent('2026-08-13 04:05:06 UTC');
    // Every fact arrived, none was dropped for being unfamiliar.
    expect(rowKeys(s.container)).toHaveLength(FACTS.length);
  });

  it('⚠️ NO facts is «nothing could be read», explicitly NOT a clean bill of health', async () => {
    renderScreen(stub({ facts: [] }));
    const empty = await screen.findByTestId('security-empty');
    expect(empty).toHaveTextContent(/not a clean result/i);
    expect(empty).toHaveTextContent(/could not be checked/i);
    // ⛔ And nothing anywhere claims a pass.
    expect(screen.queryByTestId('security-summary')).toBeNull();
    expect(document.body.textContent).not.toMatch(/in order/i);
  });

  it('error renders the retry path, and retry re-reads into the page', async () => {
    renderScreen(stub({ failGets: 1 }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.queryByTestId('security-empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('fact-row-auth.login.fixed_code')).toBeInTheDocument();
  });

  it('«Read again» asks the server again — the page never re-renders a cached posture', async () => {
    const s = stub();
    renderScreen(s);
    await screen.findByTestId('fact-row-auth.login.fixed_code');
    fireEvent.click(screen.getByTestId('security-refresh'));
    await waitFor(() =>
      expect(s.reads.filter((r) => r === 'admin-security').length).toBeGreaterThanOrEqual(2),
    );
  });
});

describe('⭐⭐ a built-in fact is a PROPERTY, not a setting that happens to be on', () => {
  it('it is labelled «built into the product» and carries no state badge to read as «on»', async () => {
    renderScreen(stub());
    const row = await screen.findByTestId('fact-row-auth.api_keys.empty_list_denies_all');

    expect(row).toHaveAttribute('data-origin', 'built_in');
    expect(screen.getByTestId('fact-origin-auth.api_keys.empty_list_denies_all')).toHaveTextContent(
      'built into the product',
    );
    // ⚠️ Its wire `state: 'ok'` is a formality, so it is NOT rendered as a check that passed.
    expect(screen.queryByTestId('fact-state-auth.api_keys.empty_list_denies_all')).toBeNull();
    // …and the row still says what the property IS, in the owning service's own words.
    expect(row).toHaveTextContent('пустой список адресов запрещает всё');
  });

  it('⛔ nothing on this page is a control: no switch, no checkbox, no input', async () => {
    const s = renderScreen(stub());
    await screen.findByTestId('fact-row-auth.api_keys.empty_list_denies_all');
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(s.container.querySelectorAll('input')).toHaveLength(0);
  });

  it('a READ fact says so, and the legend explains both words once', async () => {
    renderScreen(stub());
    await screen.findByTestId('fact-row-auth.login.fixed_code');
    expect(screen.getByTestId('fact-origin-auth.login.fixed_code')).toHaveTextContent('read');
    const legend = screen.getByTestId('security-legend');
    expect(legend).toHaveTextContent(/came from a query just now/i);
    expect(legend).toHaveTextContent(/not a setting/i);
  });

  it('⚠️ an origin this build does not recognise is «unclear», never «read»', async () => {
    renderScreen(
      stub({ facts: [{ ...FACTS[1]!, key: 'strange.origin', kind: 'inferred', severity: 'critical' }] }),
    );
    const badge = await screen.findByTestId('fact-origin-strange.origin');
    expect(badge).toHaveTextContent('origin unclear');
    expect(badge).not.toHaveTextContent(/^read$/);
  });
});

describe('⭐⭐ «unknown» never looks like «ok»', () => {
  it('the badge, the tone and the row state all say NOT CHECKED', async () => {
    renderScreen(stub());
    const unknownRow = await screen.findByTestId('fact-row-chats.unavailable');
    const okRow = screen.getByTestId('fact-row-made.up.by.a.newer.service');

    expect(unknownRow).toHaveAttribute('data-state', 'unknown');
    expect(okRow).toHaveAttribute('data-state', 'ok');

    const unknownBadge = screen.getByTestId('fact-state-chats.unavailable');
    const okBadge = screen.getByTestId('fact-state-made.up.by.a.newer.service');
    expect(unknownBadge).toHaveTextContent('not checked');
    expect(okBadge).toHaveTextContent('in order');
    // Not merely different words — a different tone, and the loudest one on the page.
    expect(unknownBadge.className).not.toEqual(okBadge.className);
    expect(unknownBadge.className).toContain('destructive');
    expect(okBadge.className).not.toContain('destructive');
  });

  it('⭐ the summary LEADS with what could not be read, ahead of what needs a look', async () => {
    renderScreen(stub());
    const summary = await screen.findByTestId('security-summary');
    // A page headlining «2 need a look» while one could not be read has reported an outage as a
    // shorter checklist.
    expect(summary).toHaveAttribute('data-summary', 'unreadable');
    expect(summary).toHaveTextContent('1 of 5 could not be read');
    expect(summary).toHaveTextContent(/unread check is not a passed check/i);
    expect(summary).toHaveTextContent(/further 2 asked for your attention/i);
  });

  it('a state word this build does not know is treated as UNKNOWN, not as ok', async () => {
    // The cautious end on purpose: a newer service inventing a state must not buy itself a pass.
    renderScreen(stub({ facts: [{ ...FACTS[4]!, key: 'strange.state', state: 'degraded' }] }));
    const row = await screen.findByTestId('fact-row-strange.state');
    expect(row).toHaveAttribute('data-state', 'unknown');
    expect(screen.getByTestId('fact-state-strange.state')).toHaveTextContent('not checked');
  });

  it('with everything read and nothing to do, the summary says exactly that', async () => {
    renderScreen(stub({ facts: [{ ...FACTS[1]!, severity: 'informational' }] }));
    const summary = await screen.findByTestId('security-summary');
    expect(summary).toHaveAttribute('data-summary', 'clear');
    expect(summary).toHaveTextContent(/none asks for anything/i);
  });
});

describe('⭐ facts are grouped by how much attention they deserve', () => {
  it('critical first, informational last — and the unclassified group ahead of them all', async () => {
    const s = renderScreen(stub());
    await screen.findByTestId('fact-row-auth.login.fixed_code');

    expect(rowKeys(s.container)).toEqual([
      // A severity this build does not know: shown FIRST and unrated, never guessed at.
      'made.up.by.a.newer.service',
      'chats.unavailable',
      'auth.login.fixed_code',
      'auth.api_keys.without_addresses',
      'auth.api_keys.empty_list_denies_all',
    ]);

    // The groups are labelled, so the ordering is readable rather than merely correct.
    expect(screen.getByTestId('severity-critical')).toHaveTextContent('Critical');
    expect(screen.getByTestId('severity-unrecognised')).toHaveTextContent(
      'Not classified by this version',
    );
    expect(screen.getByTestId('severity-informational')).toHaveTextContent('Informational');
  });

  it('a group with no facts is not rendered at all', async () => {
    renderScreen(stub({ facts: [FACTS[3]!] }));
    await screen.findByTestId('severity-critical');
    expect(screen.queryByTestId('severity-informational')).toBeNull();
    expect(screen.queryByTestId('severity-unrecognised')).toBeNull();
  });

  it('⭐ the screen names no fact key: a fact invented today renders in full', async () => {
    const invented: SecurityFactWire = {
      key: 'some.service.invented.this.morning',
      label: 'A fact nobody wrote a line of screen code for',
      severity: 'critical',
      kind: 'read',
      state: 'attention',
      value: '42',
      note: 'and its note',
    };
    renderScreen(stub({ facts: [invented] }));
    const row = await screen.findByTestId('fact-row-some.service.invented.this.morning');
    expect(row).toHaveTextContent('A fact nobody wrote a line of screen code for');
    expect(row).toHaveTextContent('42');
    expect(row).toHaveTextContent('and its note');
  });
});

describe('⛔ the page is an administrator read', () => {
  it('without platform.settings.manage: the refusal in words, and NOT ONE request is fired', async () => {
    const s = stub();
    renderScreen(s, ['crm.inbox.view']);
    const denied = await screen.findByTestId('security-denied');
    expect(denied).toHaveTextContent('platform.settings.manage');
    expect(denied).toHaveTextContent('administrator');
    expect(s.reads).toHaveLength(0);
    expect(screen.queryByTestId('security-summary')).toBeNull();
    expect(screen.queryByTestId('security-refresh')).toBeNull();
  });
});
