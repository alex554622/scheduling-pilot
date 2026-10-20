import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * App rules moved into Settings, as its "App rules" tab (see
 * `@/components/app-rules-panel`). This address is kept so bookmarks and old
 * links still land in the right place.
 */
export const Route = createFileRoute("/_authenticated/app-rules")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", search: { tab: "rules" }, replace: true });
  },
});
