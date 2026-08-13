import { People } from '@/features/people/people';

/**
 * People & groups (block W14, roadmap 3.8 + 3.9) — the first REAL section of the Admin Center.
 *
 * ⓘ Two segments under `/admin`, so the centre's own page keeps listing what is still reserved
 * while this one section stops being a promise.
 */
export default function AdminPeoplePage() {
  return <People />;
}
