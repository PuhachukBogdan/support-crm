import { Audit } from '@/features/audit/audit';

/**
 * Audit log (block W16, subpoint 3.12 / roadmap 9.18 minimum) — written since April, readable at
 * last: one table over the federated `GET /audit`, filtered by action class.
 */
export default function AdminAuditPage() {
  return <Audit />;
}
