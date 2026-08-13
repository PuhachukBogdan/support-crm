import { ApiKeys } from '@/features/api-keys/api-keys';

/**
 * ⭐ W31 (спек №2 / feature 038, roadmap 3.17) — the keys other systems call us with: issued,
 * rotated and revoked here, with the value shown once and never again (ADR 0043 §5).
 */
export default function AdminApiKeysPage() {
  return <ApiKeys />;
}
