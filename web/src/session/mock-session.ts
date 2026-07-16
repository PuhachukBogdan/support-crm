import type { Session } from './session';

/**
 * ⚠️ NON-SECURITY MOCK — demo only. This is NOT authentication or authorization
 * (Principle II is NOT satisfied by it). It performs no credential check and accepts any
 * caller; it stores only a non-sensitive "logged-in" flag (no token, credential, or PII).
 * Replaced by the real Auth service behind the `Session` interface (Phase 3 / roadmap 8.6).
 */
export const SESSION_STORAGE_KEY = 'crm.demo.session';
const FLAG = '1'; // deliberately opaque + non-sensitive

export class MockSession implements Session {
  isAuthenticated(): boolean {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem(SESSION_STORAGE_KEY) === FLAG;
    } catch {
      return false;
    }
  }

  login(): void {
    try {
      window.localStorage.setItem(SESSION_STORAGE_KEY, FLAG);
    } catch {
      /* storage unavailable — demo stays logged out */
    }
  }

  logout(): void {
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* no-op */
    }
  }
}
