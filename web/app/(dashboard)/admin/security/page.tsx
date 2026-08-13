import { SecurityPosture } from '@/features/security-posture/security-posture';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.11) — what the account’s protections actually are, every
 * line read from the system rather than asserted. A fact that could not be established is shown as
 * «not checked» and never as a protection that passed.
 */
export default function AdminSecurityPage() {
  return <SecurityPosture />;
}
