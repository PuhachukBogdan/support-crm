import { render, screen } from '@testing-library/react';
import { SessionProvider } from '@/session/session-provider';
import { GatewaySession } from '@/session/gateway-session';
import { Inbox } from './inbox';
import { Providers } from '../../../app/providers';
import { getDataAccess, setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';
import { stubConversations } from './test-support';
import { EXPORT_PERMISSION } from './bulk-actions';
import type { HttpPort } from '@/data/gateway/http-port';
import type { SessionState } from '@/session/session';

/**
 * T035 (feature 029, US5) — **what an agent SEES. This file asserts tidiness, not enforcement.**
 *
 * ⚠️⚠️ Read the title of every test here as "…is not rendered", never "…is not permitted". The
 * guarantee that an agent cannot export lives in the server: `POST /exports/:scope` refuses without
 * `crm.exports.conversations`, and SEC-AP2 refuses a mass contact export for **every** role. That
 * refusal is asserted directly on the wire in Track B (quickstart B5), because a hidden button proves
 * nothing about what a crafted request can do.
 *
 * The reason to be pedantic: a future reader who takes these as the security tests will feel covered
 * and will not write the ones that matter.
 */
afterEach(() => setDataAccess(new MockDataAccess()));

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

function renderAs(permissionKeys: string[]) {
  const seed: SessionState = {
    kind: 'authenticated',
    userId: 'u1',
    accountId: 'a1',
    roles: [],
    permissionKeys,
  };
  return render(
    <Providers dataAccess={getDataAccess()}>
      <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
        <Inbox />
      </SessionProvider>
    </Providers>,
  );
}

describe('*** the export control is not RENDERED for an agent (FR-018) ***', () => {
  it('an agent without the export permission sees no export control and no checkboxes', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderAs(['crm.inbox.view']);
    await screen.findByText('Conversation 1');

    expect(screen.queryByTestId('inbox-bulk-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-export')).not.toBeInTheDocument();
    // No selection affordance either: checkboxes that lead to nothing are their own defect.
    expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
  });

  it('a holder of the export permission sees the control and the selection column', async () => {
    // The positive control. Without it, "the button is absent" would also pass if the whole screen
    // failed to render, or if the permission key were misspelt in the component.
    setDataAccess(stubConversations({ count: 3 }));
    renderAs(['crm.inbox.view', EXPORT_PERMISSION]);
    await screen.findByText('Conversation 1');

    expect(screen.getByTestId('inbox-bulk-actions')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-export')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /select all/i })).toBeInTheDocument();
  });

  it('the export control is disabled until something is selected', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderAs(['crm.inbox.view', EXPORT_PERMISSION]);
    await screen.findByText('Conversation 1');

    expect(screen.getByTestId('inbox-export')).toBeDisabled();
  });

  it('⚠️ an empty permission set hides it — a missing list is deny, not "unknown so allow"', async () => {
    setDataAccess(stubConversations({ count: 3 }));
    renderAs([]);
    await screen.findByText('Conversation 1');

    expect(screen.queryByTestId('inbox-export')).not.toBeInTheDocument();
  });
});
