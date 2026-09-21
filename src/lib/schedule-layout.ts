import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

/**
 * How someone wants the schedule laid out: the classic screens, or the weekly
 * grid — the posted-sheet format, everyone down the side and the week across
 * the top, as a schedule is printed and pinned up.
 *
 * Kept on the account, in the auth user's metadata, because it is a choice
 * about the schedule rather than about a screen: whoever looks at it on their
 * phone at night wants it the way they look at it at their desk. The metadata
 * is theirs to write and comes back with the session, so it needs no table and
 * is known the moment they are signed in.
 */

export type ScheduleLayout = "classic" | "grid";

export const SCHEDULE_LAYOUTS: { value: ScheduleLayout; label: string; detail: string }[] = [
  {
    value: "classic",
    label: "Classic",
    detail: "The builder, and your own shifts listed day by day.",
  },
  {
    value: "grid",
    label: "Weekly grid",
    detail: "The posted sheet: everyone down the side, the week across the top.",
  },
];

export function useScheduleLayout(): {
  layout: ScheduleLayout;
  setLayout: (l: ScheduleLayout) => Promise<void>;
  saving: boolean;
} {
  const { user } = useAuth();
  const stored = (user?.user_metadata as { schedule_layout?: unknown } | undefined)
    ?.schedule_layout;
  // The switch answers the click, not the round trip; once the session comes
  // back with the saved value, that is what is shown.
  const [optimistic, setOptimistic] = useState<ScheduleLayout | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setOptimistic(null), [stored]);

  const setLayout = useCallback(async (l: ScheduleLayout) => {
    setOptimistic(l);
    setSaving(true);
    try {
      // Merged into the existing metadata by the auth server, so the name and
      // anything else kept there are left alone.
      const { error } = await supabase.auth.updateUser({ data: { schedule_layout: l } });
      if (error) {
        setOptimistic(null);
        throw error;
      }
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    layout: optimistic ?? (stored === "grid" ? "grid" : "classic"),
    setLayout,
    saving,
  };
}
