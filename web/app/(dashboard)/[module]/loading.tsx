import { Skeleton } from '@/components/ui/skeleton';

// Per-module skeleton shown during navigation/data load.
export default function Loading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-4 w-full max-w-sm" />
    </div>
  );
}
