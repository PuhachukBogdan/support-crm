import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from './page';
import { SESSION_STORAGE_KEY } from '@/session';

// T006 [US1] — mock login: invalid blocks; valid enters + sets mock session; no auth call.

// Ferrofluid is a WebGL background — mock it (jsdom has no WebGL; relative path because
// jest.mock with the '@/' alias trips over the '(auth)' route-group parens).
jest.mock('../../../src/components/Ferrofluid', () => ({ __esModule: true, default: () => null }));

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
  mockPush.mockClear();
});

describe('mock login', () => {
  it('blocks an invalid email and does not navigate', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Enter a valid email')).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('enters the app on valid input (mock session set, no auth call)', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/'));
    // mock session marker set — and it is a non-sensitive flag, not a token/credential.
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('1');
  });
});
