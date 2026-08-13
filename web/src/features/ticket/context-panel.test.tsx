import { render, screen, fireEvent } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { ContextPanelProvider, useContextPanel } from '@/components/shell/context-panel';
import { TicketContextPanel } from './context-panel';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { stubTicket, type TicketStub } from './test-support';

/**
 * W10 — the consolidated right rail (R27). Shape claims: what the ONE area offers, what it
 * deliberately does not, and that its placeholders SAY they are placeholders.
 */

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function renderPanel(stub: TicketStub, props: Partial<React.ComponentProps<typeof TicketContextPanel>> = {}) {
  setDataAccess(stub);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <ContextPanelProvider>
        <TicketContextPanel
          playerId="seed-player-001"
          brandId="brand-a"
          identified
          currentConversationId="c1"
          {...props}
        />
      </ContextPanelProvider>
    </Providers>,
  );
}

describe('the rail is ONE area with exactly three buttons (R27, revised 2026-08-10)', () => {
  it('⭐ offers active tickets, the player card and the knowledge base — and nothing else', () => {
    renderPanel(stubTicket());
    const rail = screen.getByLabelText('Context panels');
    expect(screen.getByTestId('rail-active')).toBeInTheDocument();
    expect(screen.getByTestId('rail-player')).toBeInTheDocument();
    expect(screen.getByTestId('rail-kb')).toBeInTheDocument();
    // ⛔ Zendesk's 3/4/5 (side conversations, approvals, apps) are still not built — the operator's
    // call. What changed is that Active tickets JOINED the rail instead of being a tab above it.
    expect(rail.querySelectorAll('button')).toHaveLength(3);
  });

  it('⭐ Active tickets is FIRST — the operator named the order', () => {
    renderPanel(stubTicket());
    const buttons = [...screen.getByLabelText('Context panels').querySelectorAll('button')];
    expect(buttons[0]).toHaveAttribute('data-testid', 'rail-active');
  });

  it('⭐ every button is an ICON that still NAMES itself — no `1`/`2` left', () => {
    renderPanel(stubTicket());
    const rail = screen.getByLabelText('Context panels');
    // The numbers were positions in a list nobody could see. Their replacement must not be a
    // different kind of silence: an icon-only control needs an accessible name.
    for (const b of rail.querySelectorAll('button')) {
      expect(b.textContent?.trim()).toBe('');
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b.querySelector('svg')).toBeInTheDocument();
    }
    expect(rail).not.toHaveTextContent('1');
    expect(rail).not.toHaveTextContent('2');
  });

  it('⭐ the duplicated tab strip is GONE — the rail is the only control', () => {
    // The complaint: «в самой боковой панельке… их сверху не было, потому что тут они дублируют друг
    // друга». Two controls for one question is what made the panel confusing.
    renderPanel(stubTicket());
    expect(screen.queryByTestId('panel-tab-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('panel-tab-active')).not.toBeInTheDocument();
  });

  it('the Knowledge Base button says it is empty rather than pretending (R19)', () => {
    renderPanel(stubTicket());
    fireEvent.click(screen.getByTestId('rail-kb'));
    expect(screen.getByTestId('kb-placeholder')).toHaveTextContent('not built yet');
  });
});

describe('the player card', () => {
  it('renders identity and history, and the GR8 block SAYS there is nothing behind it', async () => {
    renderPanel(stubTicket());
    expect(await screen.findByTestId('player-card')).toHaveTextContent('seed-player-001');
    expect(await screen.findByTestId('contact-history')).toHaveTextContent('conversations in total');
    // ⭐ An empty area would read as broken; a labelled one reads as reserved.
    expect(screen.getByTestId('gr8-placeholder')).toHaveTextContent('GR8');
    expect(screen.getByTestId('gr8-placeholder')).toHaveTextContent('does not hold this data yet');
  });

  it('an UNIDENTIFIED ticket gets a card that says so and points at the search — it asks for nothing', async () => {
    const stub = stubTicket();
    renderPanel(stub, { identified: false, playerId: '' });
    expect(await screen.findByTestId('player-card-unidentified')).toHaveTextContent('No player attached');
    // No player, no reads: a request with a blank id would be a 404 wearing a failure's clothes.
    expect(stub.playerReads).toBe(0);
  });
});

describe('the Active tickets panel (R17 — its own rail button since 2026-08-10)', () => {
  it('lists the agent’s own open work and switches ticket on click', async () => {
    const stub = stubTicket();
    renderPanel(stub);
    fireEvent.click(screen.getByTestId('rail-active'));

    const list = await screen.findByTestId('active-tickets');
    expect(list).toHaveTextContent('Active one');
    fireEvent.click(screen.getByText('Active one'));
    expect(push).toHaveBeenCalledWith('/tickets/conv-active-1');
  });

  it('⭐ asks for MY tickets that I OPENED, in non-terminal categories — the rail is that view', async () => {
    const stub = stubTicket();
    renderPanel(stub);
    fireEvent.click(screen.getByTestId('rail-active'));
    await screen.findByTestId('active-tickets');

    const call = stub.listCalls.find((q) => q.filters?.openedByOperatorId !== undefined);
    expect(call?.filters).toMatchObject({
      assigneeOperatorId: 'op-me',
      openedByOperatorId: 'op-me',
      // ⚠️ `new,open` and NOT pending: R17a says a ticket LEAVES the rail at Pending. (The entry
      // condition is opening, not the first public reply — the server has no such fact; recorded.)
      statusCategories: 'new,open',
    });
  });
});

describe('the slot itself', () => {
  it('⚠️ setPanel/clear are STABLE — an effect that fills the slot must not loop', () => {
    // The regression this pins: inline callbacks made every provider render a new identity, so a
    // consumer effect re-fired for ever (the test that never finished, 2026-08-06).
    const seen: Array<{ setPanel: unknown; clear: unknown }> = [];
    function Probe() {
      const { setPanel, clear } = useContextPanel();
      seen.push({ setPanel, clear });
      return <button type="button" onClick={() => setPanel(<span>x</span>)}>push</button>;
    }
    render(
      <ContextPanelProvider>
        <Probe />
      </ContextPanelProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    expect(seen.length).toBeGreaterThan(1); // the provider did re-render…
    expect(seen[0]!.setPanel).toBe(seen.at(-1)!.setPanel); // …and the identities held
    expect(seen[0]!.clear).toBe(seen.at(-1)!.clear);
  });
});
