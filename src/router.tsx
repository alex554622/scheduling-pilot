import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RoutePending } from "@/components/route-pending";

export const getRouter = () => {
  const queryClient = new QueryClient();

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
