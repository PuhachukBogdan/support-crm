import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { SessionProvider } from '@/session/session-provider';
import { GatewaySession } from '@/session/gateway-session';
import type { SessionState } from '@/session/session';
import type { HttpPort } from '@/data/gateway/http-port';
import { TicketWindow } from './ticket-window';
import { ContextPanelProvider } from '@/components/shell/context-panel';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { stubTicket, type TicketStub, type TicketStubOptions } from './test-support';

/**
 * ⭐ W30 (roadmap 4.15, spec 037 US2/US3) — the custom-fields block in the left column.
 *
 * What the wire gives is what renders: entries arrive already filtered by the SERVER (brand,
 * restriction), so «a hidden field is absent» is proven here as data-driven absence — no row, no
 * placeholder, no gap — and the only client judgement under test is the CONDITION (the cascade)
 * plus the write shapes. Refusals and clearing live server-side and are asserted there.
 */

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });
const KEYS = ['crm.inbox.view', 'crm.conversation.assign', 'users.list.view'];

function renderWindow(opts: TicketStubOptions = {}) {
  const stub = stubTicket(opts);
  setDataAccess(stub);
  const seed: SessionState = {
    kind: 'authenticated',
    userId: 'u1',
    accountId: 'a1',
    roles: [],
    permissionKeys: KEYS,
  };
  render(
    <Providers dataAccess={getDataAccess()}>
      <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
        <ContextPanelProvider>
          <TicketWindow id="c1" />
        </ContextPanelProvider>
      </SessionProvider>
    </Providers>,
  );
  return stub;
}

/** Radix triggers listen for pointerdown jsdom cannot fake — Enter is the guaranteed path. */
const openMenu = (testId: string) =>
  fireEvent.keyDown(screen.getByTestId(testId), { key: 'Enter' });

const fieldWrites = (stub: TicketStub) =>
  stub.writes.filter((w) => w.resource === 'conversation-field' || w.resource === 'conversation-form');

/** The frame-032 shape in miniature: L1 is the sub-category source, L2 hangs off one L1 value. */
const DEPOSITS_VIEW = {
  formKey: 'deposits',
  availableForms: [
    { key: 'default', name: 'Default' },
    { key: 'deposits', name: 'Deposits' },
  ],
  entries: [
    {
      field: { key: 'l1', label: 'Form L1 - Deposits', type: 'dropdown', required: true, restricted: false },
      order: 0,
      conditionFieldKey: '',
      conditionValue: '',
      isSubcategorySource: true,
      options: [
        { value: 'Deposit status', order: 0, active: true },
        { value: 'Deposit delay', order: 10, active: true },
      ],
    },
    {
      field: { key: 'l2', label: 'Form L2 - Deposit status', type: 'dropdown', required: true, restricted: false },
      order: 10,
      conditionFieldKey: 'l1',
      conditionValue: 'Deposit status',
      isSubcategorySource: false,
      options: [{ value: 'Declined', order: 0, active: true }],
    },
    {
      field: { key: 'amount', label: 'Deposit Amount', type: 'numeric', required: false, restricted: false },
      order: 20,
      conditionFieldKey: '',
      conditionValue: '',
      isSubcategorySource: false,
      options: [],
    },
  ],
};

describe('the cascade renders from the view, conditions judged client-side (render-only)', () => {
  it('shows the form, the unconditional fields, and NOT the child whose parent is unchosen', async () => {
    renderWindow({ fieldView: DEPOSITS_VIEW });
    await screen.findByTestId('custom-fields');
    expect(screen.getByTestId('cf-l1')).toBeInTheDocument();
    expect(screen.getByTestId('cf-amount')).toBeInTheDocument();
    // L2's condition is «l1 = Deposit status»; the sub-category echo is empty, so L2 must not exist.
    expect(screen.queryByTestId('cf-l2')).not.toBeInTheDocument();
    // Required is visible on the label — the capture's asterisk.
    expect(screen.getByTestId('cf-l1')).toHaveTextContent('Form L1 - Deposits *');
  });

  it('the sub-category ECHO is the L1 value: with it set, the child appears holding its options', async () => {
    renderWindow({ fieldView: { ...DEPOSITS_VIEW, subCategory: 'Deposit status' } });
    await screen.findByTestId('custom-fields');
    expect(screen.getByTestId('cf-l2')).toBeInTheDocument();
  });

  it('a field the server withheld simply does not exist — no row, no gap (US3 as data)', async () => {
    renderWindow({ fieldView: DEPOSITS_VIEW });
    await screen.findByTestId('custom-fields');
    // `psp` was never in the payload (restricted for this caller, or another brand's): nothing renders.
    expect(screen.queryByTestId('cf-psp')).not.toBeInTheDocument();
  });
});

describe('the two writes carry the registry shapes', () => {
  it('choosing a dropdown value PATCHes /conversations/:id/fields/:key with {value}', async () => {
    const stub = renderWindow({ fieldView: DEPOSITS_VIEW });
    await screen.findByTestId('custom-fields');
    openMenu('cf-input-l1');
    fireEvent.click(await screen.findByText('Deposit delay'));
    await waitFor(() =>
      expect(fieldWrites(stub)).toContainEqual(
        expect.objectContaining({
          resource: 'conversation-field',
          id: 'l1',
          payload: { value: 'Deposit delay' },
          within: 'c1',
        }),
      ),
    );
  });

  it('committing a numeric value writes through the same route', async () => {
    const stub = renderWindow({ fieldView: DEPOSITS_VIEW });
    await screen.findByTestId('custom-fields');
    fireEvent.click(screen.getByTestId('cf-input-amount'));
    const input = screen.getByTestId('cf-input-amount-input');
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(fieldWrites(stub)).toContainEqual(
        expect.objectContaining({
          resource: 'conversation-field',
          id: 'amount',
          payload: { value: '150' },
        }),
      ),
    );
  });

  it('changing the form PATCHes /conversations/:id/form with {formKey}', async () => {
    const stub = renderWindow({ fieldView: DEPOSITS_VIEW });
    await screen.findByTestId('custom-fields');
    openMenu('field-form');
    fireEvent.click(await screen.findByText('Default'));
    await waitFor(() =>
      expect(fieldWrites(stub)).toContainEqual(
        expect.objectContaining({
          resource: 'conversation-form',
          payload: { formKey: 'default' },
          within: 'c1',
        }),
      ),
    );
  });
});

describe('the solve gate’s WORDS live on the screen (the REST edge is message-free — SC-007)', () => {
  it('names the empty required fields proactively, and stops once they are filled', async () => {
    renderWindow({ fieldView: DEPOSITS_VIEW });
    await screen.findByTestId('custom-fields');
    // l1 is required and empty → named by label. amount is optional → not named.
    expect(screen.getByTestId('custom-fields-required-hint')).toHaveTextContent(
      'Required to solve: Form L1 - Deposits',
    );
  });

  it('a filled required field leaves the hint (and an all-filled form has none)', async () => {
    renderWindow({
      fieldView: {
        ...DEPOSITS_VIEW,
        subCategory: 'Deposit status', // l1 (the source) filled → l2 appears, required and empty
        values: [{ fieldKey: 'l2', value: 'Declined' }], // …and filled too
      },
    });
    await screen.findByTestId('custom-fields');
    expect(screen.queryByTestId('custom-fields-required-hint')).not.toBeInTheDocument();
  });
});

describe('absence and failure keep their shapes apart', () => {
  it('an account with nothing configured renders NO block at all — absent reads as not set up', async () => {
    renderWindow(); // the stub's default: no forms, no entries
    await screen.findByTestId('field-status'); // the window itself is up
    expect(screen.queryByTestId('custom-fields')).not.toBeInTheDocument();
    expect(screen.queryByTestId('custom-fields-error-state')).not.toBeInTheDocument();
  });

  it('a failed view read degrades ALONE, with a retry — the window keeps working', async () => {
    // DataError's discriminant is `code`, not `kind` (web/src/data/types.ts).
    renderWindow({ failFieldViewWith: { message: 'boom', code: 'unavailable', retryable: true } });
    await screen.findByTestId('custom-fields-error-state');
    // The rest of the column is untouched by the annotation's failure (the TagsBlock rule).
    expect(screen.getByTestId('field-status')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });
});
