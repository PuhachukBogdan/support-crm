import { render, screen, waitFor } from '@testing-library/react';
import { SessionGuard } from './session-guard';
import { MockSession } from './mock-session';

// T011 [US3] — the route guard: redirect when logged out; render children when logged in.

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
  mockReplace.mockClear();
});

describe('SessionGuard', () => {
  it('redirects to /login and hides protected content when logged out', async () => {
    render(
      <SessionGuard>
        <div>secret content</div>
      </SessionGuard>,
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
  });

  it('renders children when a mock session exists', async () => {
    new MockSession().login();
    render(
      <SessionGuard>
        <div>secret content</div>
      </SessionGuard>,
    );
    expect(await screen.findByText('secret content')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
