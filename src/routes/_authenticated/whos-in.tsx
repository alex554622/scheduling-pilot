import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Who's in was retired: the dashboard's Today's roster shows who is working,
 * on a break or off, and an admin ends a break early from Timecards (Edit on
 * the day). This address is kept so bookmarks and old links land on the
 * dashboard.
 */
export const Route = createFileRoute("/_authenticated/whos-in")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard", replace: true });
  },
});
