/**
 * The session boundary (mock-auth). Screens and the route guard depend ONLY on this
 * interface / the useSession hook — never on localStorage directly. The real Auth service
 * (Phase 3 / roadmap 8.6) swaps in behind this interface without changing screens.
 *
 * ⚠️ This is NOT authentication/authorization (Principle II). See MockSession.
 */
export interface Session {
  isAuthenticated(): boolean;
  login(): void;
  logout(): void;
}
