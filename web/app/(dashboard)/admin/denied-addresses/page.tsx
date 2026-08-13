import { DeniedAddresses } from '@/features/denied-addresses/denied-addresses';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.10) — the addresses the boundary refuses before anybody
 * signs in. An empty list here denies nobody, which is the opposite of the address list on an API
 * key — the screen says so in words for exactly that reason.
 */
export default function AdminDeniedAddressesPage() {
  return <DeniedAddresses />;
}
