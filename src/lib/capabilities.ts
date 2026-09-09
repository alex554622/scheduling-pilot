import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

/**
 * What a company's subscription plan lets it do.
 *
 * Distinct from `@/lib/app-rules`, which is how a company configures features
 * it already has. This is whether it has them at all — a super admin decides
 * that per plan, on the Platform page.
 */
export type CapabilityKey =
  | "schedule_design"
  | "schedule_publish"
  | "auto_scheduling"
  | "org_structure"
  | "availability"
  | "time_clock"
  | "geofence"
  | "timecards"
  | "shift_trades"
  | "time_off"
  | "reports"
  | "audit_log";

export type Capabilities = Record<CapabilityKey, boolean>;

/** Order and copy for the super admin's plan editor. */
export const CAPABILITY_LABELS: { key: CapabilityKey; label: string; hint: string }[] = [
  { key: "schedule_design", label: "Design schedules", hint: "Build and edit shifts" },
  { key: "schedule_publish", label: "Post schedules", hint: "Release a schedule to staff" },
  { key: "auto_scheduling", label: "Auto-scheduling", hint: "Generate schedules from rules" },
  { key: "org_structure", label: "Organization", hint: "Departments, locations, positions" },
  { key: "availability", label: "Availability", hint: "Staff set when they can work" },
  { key: "time_clock", label: "Time clock", hint: "Clock in / out and breaks" },
  { key: "geofence", label: "Geofencing", hint: "Location rules on punches" },
  { key: "timecards", label: "Timecards", hint: "Timecards, printing and CSV export" },
  { key: "shift_trades", label: "Shift trades", hint: "Staff swap shifts" },
  { key: "time_off", label: "Time off", hint: "Time-off requests and approvals" },
  { key: "reports", label: "Reports", hint: "Reports and exports" },
  { key: "audit_log", label: "Audit log", hint: "Who changed what, and when" },
];

/** Nothing is granted by default — a plan has to say yes. */
export const NO_CAPABILITIES: Capabilities = CAPABILITY_LABELS.reduce(
  (acc, c) => ({ ...acc, [c.key]: false }),
  {} as Capabilities,
);

export const ALL_CAPABILITIES: Capabilities = CAPABILITY_LABELS.reduce(
  (acc, c) => ({ ...acc, [c.key]: true }),
  {} as Capabilities,
);

/** Coerce whatever is stored in `pricing_plans.capabilities` into a full set. */
export function normalizeCapabilities(raw: unknown): Capabilities {
  const source = (raw ?? {}) as Record<string, unknown>;
  return CAPABILITY_LABELS.reduce(
    (acc, c) => ({ ...acc, [c.key]: source[c.key] === true }),
    {} as Capabilities,
  );
}

/** "Up to 25 employees" / "Unlimited employees", straight from the seat cap. */
export function seatLine(maxEmployees: number | null | undefined): string {
  return maxEmployees == null ? "Unlimited employees" : `Up to ${maxEmployees} employees`;
}

/**
 * The bullet list for a pricing card.
 *
 * Built from the capabilities the plan actually grants, so what a customer is
 * promised and what the app unlocks cannot drift apart. Hand-written `features`
 * rows survive as extras for things that aren't capabilities at all ("Priority
 * support"), with anything that merely restates a capability dropped.
 */
export function planBullets(capabilities: unknown, extras: unknown): string[] {
  const granted = normalizeCapabilities(capabilities);
  const fromCapabilities = CAPABILITY_LABELS.filter((c) => granted[c.key]).map((c) => c.label);

  const taken = new Set(fromCapabilities.map((l) => l.toLowerCase()));
  const custom = (Array.isArray(extras) ? (extras as unknown[]) : [])
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.trim())
    .filter((f) => f && !taken.has(f.toLowerCase()));

  // The seat count is the card's subtitle, not a bullet — see `seatLine`.
  return [...fromCapabilities, ...custom];
}

/**
 * The signed-in user's company capabilities.
 *
 * A super admin belongs to no company and administers every plan, so they are
 * never gated — returning the full set keeps the checks at call sites simple.
 */
export function useCapabilities(): { capabilities: Capabilities; isLoading: boolean } {
  const { company, primaryRole } = useAuth();
  const isSuperAdmin = primaryRole === "super_admin";

  const q = useQuery({
    queryKey: ["company-capabilities", company?.id],
    enabled: !!company?.id && !isSuperAdmin,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("company_capabilities", { _company: company!.id });
      if (error) throw error;
      return normalizeCapabilities(data);
    },
  });

  if (isSuperAdmin) return { capabilities: ALL_CAPABILITIES, isLoading: false };
  // Until the plan is known, grant nothing rather than flashing features the
  // company may not be paying for.
  return { capabilities: q.data ?? NO_CAPABILITIES, isLoading: q.isLoading };
}
