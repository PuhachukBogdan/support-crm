// Neutral, brand-free, synthetic demo records (Principle V — no real/PII data).
// Deterministic generation so tests are stable.

export type DemoStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type DemoPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface DemoRecord {
  id: string;
  subject: string;
  status: DemoStatus;
  priority: DemoPriority;
  updatedAt: string; // ISO
}

const STATUSES: DemoStatus[] = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES: DemoPriority[] = ['low', 'normal', 'high', 'urgent'];
const BASE_MS = Date.UTC(2026, 0, 1);

/** Generate `count` deterministic demo records with zero-padded, keyset-sortable ids. */
export function makeDemoRecords(count: number): DemoRecord[] {
  const out: DemoRecord[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      id: String(i + 1).padStart(8, '0'),
      subject: `Demo request #${i + 1}`,
      status: STATUSES[i % STATUSES.length]!,
      priority: PRIORITIES[i % PRIORITIES.length]!,
      updatedAt: new Date(BASE_MS + i * 60_000).toISOString(),
    };
  }
  return out;
}
