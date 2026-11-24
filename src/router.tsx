import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RoutePending } from "@/components/route-pending";

export const getRouter = () => {
  // React Query's defaults treat every answer as stale at once and refetch every
  // query on screen each time the window regains focus — on phones that is every
  // switch back to the app, for every user at once at shift change. Keep answers
  // for 30s (pages that need fresher data set their own staleTime/realtime), and
  // back off retries so a struggling server isn't hit three times as hard.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failures, error) => {
          const status = (error as { status?: number; code?: string })?.status;
          if (status && status >= 400 && status < 500) return false;
          return failures < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000) + Math.random() * 1000,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Every page is its own chunk (TanStack Start code-splits routes). Start
    // fetching it on hover/touchstart so most taps land on code that is
    // already there; the signed-in shell also warms its menu's pages on idle.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // If a page's code still isn't ready shortly after the tap, swap in a
    // skeleton instead of leaving the old page up looking frozen. The default
    // is a full second, and with no pending component nothing showed at all.
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 120,
    defaultPendingMinMs: 200,
  });

  return router;
};
