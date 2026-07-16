import { render, screen } from '@testing-library/react';
import { Providers } from '../providers';
import DashboardHome from './page';
import { setDataAccess } from '@/data/provider';
import { MockDataAccess } from '@/data/mock/mock-data-access';

// T008 [US2] — dashboard renders a mock ticket list via the C interface, with shared states.

afterEach(() => {
  setDataAccess(new MockDataAccess()); // reset to default binding
});

describe('dashboard ticket list', () => {
  it('renders mock tickets in the DataTable via useRecords', async () => {
    setDataAccess(new MockDataAccess({ count: 25 }));
    render(
      <Providers>
        <DashboardHome />
      </Providers>,
    );
    expect(await screen.findByText('Demo request #1')).toBeInTheDocument();
    // StatusBadge cells rendered for statuses.
    expect(screen.getAllByText(/open|pending|resolved|closed/i).length).toBeGreaterThan(0);
  });

  it('shows the shared loading state while pending', () => {
    setDataAccess(new MockDataAccess({ count: 5, delayMs: 50 }));
    render(
      <Providers>
        <DashboardHome />
      </Providers>,
    );
    expect(screen.getByTestId('dt-loading')).toBeInTheDocument();
  });

  it('shows the shared empty state when the mock returns nothing', async () => {
    setDataAccess(new MockDataAccess({ count: 0 }));
    render(
      <Providers>
        <DashboardHome />
      </Providers>,
    );
    expect(await screen.findByTestId('dt-empty')).toBeInTheDocument();
  });
});
