import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Organization moved into Settings, as its "Organization" tab (see
 * `@/components/organization-panel`). This address is kept so bookmarks and
 * old links still land in the right place.
 */
export const Route = createFileRoute("/_authenticated/organization")({
  beforeLoad: () => {
    throw redirect({ to: "/settings", search: { tab: "organization" }, replace: true });
  },
});
