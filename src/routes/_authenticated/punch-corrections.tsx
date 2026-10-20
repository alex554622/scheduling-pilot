import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Punch corrections was retired: an admin corrects punches from Timecards, with
 * the Edit button on a day (`TimecardDayEditor`), which writes through the same
 * audited manager_* functions — every change is still logged with its reason
 * in `time_punch_audit`. This address is kept so bookmarks and old links land
 * on Timecards.
 */
export const Route = createFileRoute("/_authenticated/punch-corrections")({
  beforeLoad: () => {
    throw redirect({ to: "/timecards", search: {}, replace: true });
  },
});
