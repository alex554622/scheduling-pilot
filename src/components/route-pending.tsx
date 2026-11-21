import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while the router fetches the code for the page someone just picked.
 * Without it the previous page stays on screen with nothing moving until the
 * new one is ready, which on a phone reads as the app having frozen.
 *
 * Inside the signed-in shell this renders in the content area, so the menu and
 * header stay put; on public pages it stands on its own.
 */
export function RoutePending() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
      <Skeleton className="h-56 rounded-2xl" />
    </div>
  );
}
