import { admin } from "./admin";
import { people } from "./people";
import { schedule } from "./schedule";
import { shell } from "./shell";
import { time } from "./time";
import { timecards } from "./timecards";

/**
 * Spanish, keyed by the English text, one dictionary per area of the app.
 *
 * A screen that passes its area to `useT(area)` is answered from that area
 * first, because a short word does not always translate the same way: "Off" on
 * the schedule is a day off (Libre), on a settings switch it is Desactivado.
 * Anything an area does not have falls back to the merged dictionary below.
 */
export const ES_AREAS = { shell, schedule, timecards, admin, people, time };

export type Area = keyof typeof ES_AREAS;

export const ES: Record<string, string> = {
  ...shell,
  ...schedule,
  ...timecards,
  ...admin,
  ...people,
  ...time,
};
