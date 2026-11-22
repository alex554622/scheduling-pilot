import { AlarmClock } from "lucide-react";
import { useLocaleTag, useT } from "@/lib/i18n";
import type { Lateness } from "@/lib/lateness";

/**
 * "Late 12m" beside a clock-in that came in past the grace period. Renders
 * nothing for an on-time clock-in, so callers can pass whatever `useLateness`
 * returned for the punch.
 */
export function LateBadge({
  lateness,
  className = "",
}: {
  lateness?: Lateness;
  className?: string;
}) {
  const t = useT("time");
  const tag = useLocaleTag();
  if (!lateness?.late) return null;
  const start = new Date(lateness.shiftStart).toLocaleTimeString(tag, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-500/15 dark:text-red-300 ${className}`}
      title={t("Clocked in {n} min after the {time} shift start", {
        n: lateness.minutesLate,
        time: start,
      })}
    >
      <AlarmClock className="h-3 w-3" />
      {t("Late {n}m", { n: lateness.minutesLate })}
    </span>
  );
}
