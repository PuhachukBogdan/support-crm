import { MockSession, SESSION_STORAGE_KEY } from './mock-session';

// T010 [US3] — mock session: no-secret marker, survives reload, login/logout, no network.

beforeEach(() => localStorage.clear());

describe('MockSession', () => {
  it('starts logged out', () => {
    expect(new MockSession().isAuthenticated()).toBe(false);
  });

  it('login stores only a non-sensitive flag (no token/credential/PII)', () => {
    const s = new MockSession();
    s.login();
    expect(s.isAuthenticated()).toBe(true);
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    expect(stored).toBe('1');
    // Definitely nothing sensitive in the stored value.
    expect(stored).not.toMatch(/@|token|bearer|password|jwt|\./i);
  });

  it('survives a reload (a fresh instance reads the persisted flag)', () => {
    new MockSession().login();
    expect(new MockSession().isAuthenticated()).toBe(true); // simulated reload
  });

  it('logout clears the session', () => {
    const s = new MockSession();
    s.login();
    s.logout();
    expect(s.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});
