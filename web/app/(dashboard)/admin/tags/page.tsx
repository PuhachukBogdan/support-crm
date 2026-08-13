import { Tags } from '@/features/tags/tags';

/**
 * Tag registry (block W16, subpoint 3.11 / roadmap 9.15 minimum) — every label with how many
 * conversations carry it, busiest first.
 */
export default function AdminTagsPage() {
  return <Tags />;
}
